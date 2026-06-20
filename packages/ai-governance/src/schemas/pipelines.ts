// SPDX-License-Identifier: AGPL-3.0-or-later
//
// AI content-pipeline outputs (WS-K.1.3a/b, SPEC §24.1). Topic classification
// assigns multi-label topics with confidence (sub-threshold labels are suggested
// for review, never auto-applied); claim extraction produces discrete, editable
// propositions linked to their source passage. Both carry the persistent
// provenance label (AI-classified / AI-draft) and an `output_id` linking the
// audit record (WS-K.1.1f). These are the GOVERNED counterparts of the WS-F
// heuristic seam: the same content work, now carrying full provenance.
import { z } from 'zod';
import { refIdSchema, semverSchema, shortTextSchema } from './common.js';
import { aiProvenanceLabelSchema } from './labels.js';

const unit = z.number().min(0).max(1);

// --- WS-K.1.3a topic classification -----------------------------------------

/** One topic label assignment with confidence and applied/suggested status. */
export const topicAssignmentSchema = z
  .object({
    /** Canonical topic taxonomy id (WS-A). */
    topic_id: shortTextSchema,
    confidence: unit,
    /** True ⇒ confidence ≥ threshold and the label was applied; false ⇒ it is
     *  a sub-threshold SUGGESTION routed to review, not applied. */
    applied: z.boolean(),
    label: aiProvenanceLabelSchema,
  })
  .strict();
export type TopicAssignment = z.infer<typeof topicAssignmentSchema>;

export const topicClassificationResultSchema = z
  .object({
    story_id: refIdSchema,
    assignments: z.array(topicAssignmentSchema),
    /** The confidence threshold in force (configurable, default 0.7). */
    threshold: unit,
    model_name: shortTextSchema,
    model_version: semverSchema,
    output_id: refIdSchema,
    classified_at: z.string().datetime(),
  })
  .strict();
export type TopicClassificationResult = z.infer<typeof topicClassificationResultSchema>;

// --- WS-K.1.3b claim extraction ---------------------------------------------

export const extractedClaimSchema = z
  .object({
    claim_text: z.string().min(1).max(1_000),
    confidence: unit,
    /** The exact source passage the claim was derived from. */
    source_passage: z.string().min(1).max(2_000),
    label: aiProvenanceLabelSchema,
  })
  .strict();
export type ExtractedClaim = z.infer<typeof extractedClaimSchema>;

export const claimExtractionResultSchema = z
  .object({
    story_id: refIdSchema,
    claims: z.array(extractedClaimSchema),
    model_name: shortTextSchema,
    model_version: semverSchema,
    output_id: refIdSchema,
    extracted_at: z.string().datetime(),
  })
  .strict();
export type ClaimExtractionResult = z.infer<typeof claimExtractionResultSchema>;
