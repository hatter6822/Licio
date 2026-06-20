// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Audit-sensitive AI output record (WS-K.1.1f, SPEC §24.2/§28.2). For any output
// that can influence moderation, ranking, governance, user trust, or a label
// shown to users, the system writes an immutable `AIOutputRecord` capturing the
// model name + version, the prompt template id, the config hash, the input refs,
// the output ref, the use case, and the timestamp. This is the source for the
// §28.2 experiment-log requirement (experiment logs include model versions) and
// the substrate the runtime monitor (WS-K.1.2f) samples. Records reference —
// never duplicate — sensitive payloads, and link any downstream human
// correction (WS-K.1.3c/1.4c).
import { z } from 'zod';
import { aiUseCaseIdSchema, refIdSchema, semverSchema, shortTextSchema } from './common.js';

export const aiOutputRecordSchema = z
  .object({
    output_id: refIdSchema,
    model_name: shortTextSchema,
    model_version: semverSchema,
    /** Stable id of the prompt/config template that produced the output. */
    prompt_template_id: refIdSchema,
    /** Deterministic hash of the full model configuration (SHA-256 hex). */
    config_hash: z.string().regex(/^[0-9a-f]{64}$/, 'config_hash must be SHA-256 hex'),
    /** References to the inputs (story id, thread id, …) — not the payloads. */
    input_refs: z.array(refIdSchema),
    /** Reference to the produced output (claim id, summary id, …). */
    output_ref: refIdSchema,
    use_case_id: aiUseCaseIdSchema,
    /** A downstream human correction's reference, once one exists. */
    correction_ref: refIdSchema.nullable(),
    timestamp: z.string().datetime(),
  })
  .strict();
export type AiOutputRecord = z.infer<typeof aiOutputRecordSchema>;
