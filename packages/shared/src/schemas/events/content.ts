// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Content lifecycle events (WS-E.1.1a, SPEC §21.3/§14.1). Content events are
// `public` by design — they describe what the author intends others to see and
// carry NO behavioral signal. Strict parsing prevents a malicious or buggy
// client from smuggling extra fields (e.g. raw URLs of off-app browsing) into a
// public topic.
import { z } from 'zod';
import { httpUrlSchema, uuidSchema } from '../common.js';
import { eventBaseShape } from './envelope.js';

/** The six submission types (SPEC §14.1). */
export const SUBMISSION_TYPES = [
  'link',
  'original_brief',
  'question',
  'evidence_card',
  'local_update',
  'live_thread',
] as const;
export type SubmissionType = (typeof SUBMISSION_TYPES)[number];
export const submissionTypeSchema = z.enum(SUBMISSION_TYPES);

/** Fields shared by `content.submitted` and `content.normalized`. */
const contentShape = {
  ...eventBaseShape,
  story_id: uuidSchema,
  /** The submitting user. */
  submitted_by: uuidSchema,
  submission_type: submissionTypeSchema,
  /** Canonical URL for link stories; null for original content. */
  canonical_url: httpUrlSchema.nullable(),
  topic_ids: z.array(z.string().min(1).max(64)).max(20),
  privacy_classification: z.literal('public'),
  retention_tier: z.literal('public_contribution'),
} as const;

/** Emitted when a user submits a story via `POST /v1/stories` (SPEC §23.2). */
export const contentSubmittedEventSchema = z
  .object({
    ...contentShape,
    event_type: z.literal('content.submitted'),
  })
  .strict();
export type ContentSubmittedEvent = z.infer<typeof contentSubmittedEventSchema>;

/**
 * Emitted after ingestion-pipeline processing (SPEC §14.2): all submission
 * fields plus the normalization outputs (source resolution, language,
 * sensitivity labels, dedup grouping, extracted claims, embedding reference).
 */
export const contentNormalizedEventSchema = z
  .object({
    ...contentShape,
    event_type: z.literal('content.normalized'),
    source_id: uuidSchema,
    /** BCP-47 language tag of the normalized content. */
    language: z.string().min(2).max(35),
    sensitivity_labels: z.array(z.string().min(1).max(64)).max(20),
    /** Duplicate group when MERI/dedup linked this story to earlier copies. */
    duplicate_group_id: uuidSchema.nullable(),
    /** Claims extracted by the ingestion pipeline (candidate claim list). */
    claim_ids: z.array(uuidSchema).max(100),
    /** Opaque reference to the stored embedding; null when not computed. */
    embedding_ref: z.string().min(1).max(256).nullable(),
  })
  .strict();
export type ContentNormalizedEvent = z.infer<typeof contentNormalizedEventSchema>;
