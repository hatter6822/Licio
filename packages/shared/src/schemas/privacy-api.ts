// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Wire contracts for the WS-D.2 privacy-control endpoints (/v1/privacy/*):
// settings get/patch, attention-history deletion, DSAR export, and account
// deletion.  These honour the §19.3 promise that the controls ACTUALLY take
// effect (settings propagate downstream, deletion really deletes), not placebo
// toggles.
import { z } from 'zod';
import { isoTimestampSchema, uuidSchema } from './common.js';
import { personalizationSettingsSchema, privacySettingsSchema } from './privacy-settings.js';

/**
 * GET /v1/privacy/settings — the user's settings plus a derived view of the
 * effective teen floor (so the UI can show which controls are clamped).
 */
export const privacySettingsResponseSchema = z
  .object({
    privacy_settings: privacySettingsSchema,
    personalization_settings: personalizationSettingsSchema,
    /** True when a teen floor is being enforced for this account. */
    teen_floor_applied: z.boolean(),
  })
  .strict();
export type PrivacySettingsResponse = z.infer<typeof privacySettingsResponseSchema>;

/** PATCH body: partial updates to either settings blob.  `.strict()` blocks smuggling. */
export const privacySettingsPatchSchema = z
  .object({
    privacy_settings: privacySettingsSchema.partial(),
    personalization_settings: personalizationSettingsSchema.partial(),
  })
  .partial()
  .strict();
export type PrivacySettingsPatch = z.infer<typeof privacySettingsPatchSchema>;

/**
 * POST /v1/privacy/attention/delete — `delete` removes all attention history;
 * `reset` clears derived topic affinities only (the lighter variant, §19.3).
 */
export const attentionDeleteRequestSchema = z
  .object({ mode: z.enum(['delete', 'reset']).default('delete') })
  .strict();
export type AttentionDeleteRequest = z.infer<typeof attentionDeleteRequestSchema>;

export const attentionDeleteResultSchema = z
  .object({
    mode: z.enum(['delete', 'reset']),
    aggregates_removed: z.number().int().nonnegative(),
    affinities_reset: z.boolean(),
  })
  .strict();
export type AttentionDeleteResult = z.infer<typeof attentionDeleteResultSchema>;

// ---------------------------------------------------------------------------
// DSAR export (WS-D.2.2).  Job state machine + status projection.
// ---------------------------------------------------------------------------
export const EXPORT_JOB_STATES = [
  'queued',
  'processing',
  'completed',
  'failed',
  'expired',
] as const;
export type ExportJobState = (typeof EXPORT_JOB_STATES)[number];
export const exportJobStateSchema = z.enum(EXPORT_JOB_STATES);

export const exportJobStatusSchema = z
  .object({
    job_id: uuidSchema,
    status: exportJobStateSchema,
    progress_pct: z.number().int().min(0).max(100),
    created_at: isoTimestampSchema,
    completed_at: isoTimestampSchema.nullable(),
    expires_at: isoTimestampSchema.nullable(),
    /** Present only when status === 'completed' and the download is still live. */
    download_available: z.boolean(),
    /** A fresh, time-limited signed token for the download URL (when available). */
    download_token: z.string().nullable(),
  })
  .strict();
export type ExportJobStatus = z.infer<typeof exportJobStatusSchema>;

// ---------------------------------------------------------------------------
// Account deletion (WS-D.2.4).  Request → 30-day grace → deleted.
// ---------------------------------------------------------------------------
export const DELETION_STATES = ['none', 'grace_period', 'deleted', 'cancelled'] as const;
export type DeletionState = (typeof DELETION_STATES)[number];
export const deletionStateSchema = z.enum(DELETION_STATES);

export const deletionStatusSchema = z
  .object({
    state: deletionStateSchema,
    requested_at: isoTimestampSchema.nullable(),
    /** When the scheduled hard-deletion will run (requested_at + 30 days). */
    purge_at: isoTimestampSchema.nullable(),
    cancellable: z.boolean(),
  })
  .strict();
export type DeletionStatus = z.infer<typeof deletionStatusSchema>;
