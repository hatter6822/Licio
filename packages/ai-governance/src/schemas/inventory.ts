// SPDX-License-Identifier: AGPL-3.0-or-later
//
// AI use-case inventory entry (WS-K.1.1c, SPEC §24.1/§24.2). One entry per AI
// capability, version-controlled, linking the model(s) that serve it and the
// NIST/ISO risk assessment that governs it. The inventory is the NIST AI RMF
// GOVERN-function register: every AI use in the platform is listed here with its
// risk level and enforced human-oversight posture. The `never_autonomous` flag
// marks use cases (governance assistance) the AI may inform but never finalize
// (§24.1/§24.5).
import { z } from 'zod';
import {
  aiRiskLevelSchema,
  aiUseCaseIdSchema,
  humanOversightLevelSchema,
  proseSchema,
  refIdSchema,
  shortTextSchema,
} from './common.js';

export const aiUseCaseSchema = z
  .object({
    use_case_id: aiUseCaseIdSchema,
    name: shortTextSchema,
    description: proseSchema,
    /** Model names (in the registry) that serve this use case. */
    model_names: z.array(shortTextSchema),
    risk_level: aiRiskLevelSchema,
    human_oversight: humanOversightLevelSchema,
    /** The risk assessment governing this use case (WS-K.1.1c). */
    risk_assessment_ref: refIdSchema,
    /** True ⇒ AI may inform but never finalize (governance, §24.5). */
    never_autonomous: z.boolean(),
  })
  .strict()
  // A prohibited/never-autonomous posture and a critical risk level must agree:
  // critical risk REQUIRES prohibited oversight (the AI may not act), and
  // `prohibited` oversight is only valid at critical risk.
  .refine(
    (entry) => (entry.risk_level === 'critical') === (entry.human_oversight === 'prohibited'),
    {
      message: 'critical risk requires prohibited oversight, and vice versa',
      path: ['human_oversight'],
    },
  );
export type AiUseCase = z.infer<typeof aiUseCaseSchema>;

/** The whole inventory, with a monotonic version for the audit trail. */
export const aiInventorySchema = z
  .object({
    version: z.number().int().nonnegative(),
    updated_at: z.string().datetime(),
    use_cases: z.array(aiUseCaseSchema),
  })
  .strict();
export type AiInventory = z.infer<typeof aiInventorySchema>;
