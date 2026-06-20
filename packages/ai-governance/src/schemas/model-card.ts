// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Model card schema (WS-K.1.1a, SPEC §24.2). The documentation record for every
// AI model in Licio, mirroring the WS-H `InvariantCard` conventions (owner,
// version, input/output schema, known failure modes) so models and invariants
// share one audit vocabulary. No raw training data is ever stored on the card —
// only summaries and lineage references — keeping sensitive training content out
// of the broadly readable registry. `update_history` is append-only (enforced at
// the registry write boundary, WS-K.1.1b). `known_biases`/`limitations` default
// to "not yet evaluated" so an unevaluated model is visibly incomplete.
import { z } from 'zod';
import {
  aiModalitySchema,
  aiUseCaseIdSchema,
  proseSchema,
  refIdSchema,
  semverSchema,
  shortTextSchema,
} from './common.js';
import { evaluationResultSchema } from './evaluation.js';
import { aiProhibitionSchema } from './prohibited-use.js';

/** The default value for an unevaluated bias/limitation field (WS-K.1.1a). */
export const NOT_YET_EVALUATED = 'not yet evaluated' as const;

/** One append-only changelog entry (WS-K.1.1a `update_history`). */
export const updateHistoryEntrySchema = z
  .object({
    version: semverSchema,
    date: z.string().datetime(),
    description: proseSchema,
    /** A short summary of the evaluation outcome for this version. */
    evaluation_summary: shortTextSchema,
  })
  .strict();
export type UpdateHistoryEntry = z.infer<typeof updateHistoryEntrySchema>;

export const modelCardSchema = z
  .object({
    name: shortTextSchema,
    version: semverSchema,
    owner: shortTextSchema,
    purpose: proseSchema,
    /** The inventory use case this model serves (WS-K.1.1c link). */
    use_case_id: aiUseCaseIdSchema,
    /** Modalities the model exhibits — selects the harness evaluation set. */
    modalities: z.array(aiModalitySchema).min(1),
    /** Training-data sources/size/temporal range + known gaps. No raw data. */
    training_data_summary: proseSchema,
    /** Lineage records (WS-K.1.1e) for the training/evaluation datasets. */
    data_lineage_refs: z.array(refIdSchema).min(1),
    /** Structure/types of accepted inputs (doc path or schema name). */
    input_schema: shortTextSchema,
    /** Structure/types of produced outputs (doc path or schema name). */
    output_schema: shortTextSchema,
    /** The prohibited uses applicable to this model (WS-K.1.1d). */
    prohibited_uses: z.array(aiProhibitionSchema),
    /** Documented biases, or "not yet evaluated" pending evaluation. */
    known_biases: proseSchema.default(NOT_YET_EVALUATED),
    /** Documented limitations, or "not yet evaluated" pending evaluation. */
    limitations: proseSchema.default(NOT_YET_EVALUATED),
    /** Structured evaluation results (bias/safety/red-team/hallucination). */
    evaluation_results: z.array(evaluationResultSchema),
    /** The NIST/ISO risk assessment for this model's use case (WS-K.1.1c). */
    risk_assessment_ref: refIdSchema,
    /** Append-only changelog (WS-K.1.1a — entries are never modified). */
    update_history: z.array(updateHistoryEntrySchema).min(1),
  })
  .strict();
export type ModelCard = z.infer<typeof modelCardSchema>;

/** Whether a card's bias/limitation documentation is still incomplete
 *  (WS-K.1.1a observability: an incomplete card must not silently deploy). */
export function isEvaluationComplete(card: ModelCard): boolean {
  return card.known_biases !== NOT_YET_EVALUATED && card.limitations !== NOT_YET_EVALUATED;
}
