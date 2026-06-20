// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Data lineage record (WS-K.1.1e, SPEC §24.2 "maintain data lineage for
// training/evaluation"). Immutable and append-only: a new dataset version
// creates a new record linked to its predecessor. The hard precondition for the
// WS-K.1.3c fine-tuning path is encoded structurally — a record that contains
// user-derived data cannot be marked `usable` without a `privacy_review_ref`
// (the WS-D.2 privacy-review seam). Model cards reference these records by
// `data_lineage_refs`.
import { z } from 'zod';
import { proseSchema, refIdSchema, semverSchema, shortTextSchema } from './common.js';

/** One ordered transformation step with its responsible actor and time. */
export const lineageTransformationSchema = z
  .object({
    /** cleaning | de-identification | sampling | labeling | … */
    transformation: shortTextSchema,
    /** The responsible actor (team or `steward:<id>` reference). */
    actor: shortTextSchema,
    at: z.string().datetime(),
  })
  .strict();
export type LineageTransformation = z.infer<typeof lineageTransformationSchema>;

export const dataLineageRecordSchema = z
  .object({
    dataset_id: refIdSchema,
    version: semverSchema,
    /** Where the data came from (corpus name, "steward-corrected …", …). */
    source: shortTextSchema,
    /** Legal/consent basis for use (license name or consent description). */
    consent_basis: proseSchema,
    /** Whether the dataset contains user-derived content (gates the privacy
     *  review precondition below). */
    contains_user_derived: z.boolean(),
    /** Ordered transformations applied to the data. */
    transformations: z.array(lineageTransformationSchema),
    /** The privacy review that cleared the dataset, where user data is
     *  involved (WS-D.2 seam). Required for a usable user-derived dataset. */
    privacy_review_ref: refIdSchema.nullable(),
    /** Models/versions trained or evaluated on this dataset (back-reference). */
    used_by: z.array(shortTextSchema),
    /** The predecessor dataset version's id, or null for the first version. */
    predecessor_dataset_id: refIdSchema.nullable(),
    /** Whether the dataset is cleared for use. A user-derived dataset can be
     *  usable ONLY with a privacy review reference (the §24.2 precondition). */
    usable: z.boolean(),
    created_at: z.string().datetime(),
  })
  .strict()
  .refine((r) => !r.usable || !r.contains_user_derived || r.privacy_review_ref !== null, {
    message: 'a usable user-derived dataset requires a privacy_review_ref (§24.2)',
    path: ['privacy_review_ref'],
  });
export type DataLineageRecord = z.infer<typeof dataLineageRecordSchema>;
