// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Human-in-the-loop correction + feedback loop (WS-K.1.3c, SPEC §24.1/§24.2). A
// steward confirms/rejects/modifies an AI output; the correction preserves the
// original, links back to its AIOutputRecord (so the audit trail is complete),
// and accumulates as feedback. Accuracy metrics use steward corrections as
// ground truth (correction rate, agreement rate, per-category). Feedback enters
// training ONLY via the privacy-reviewed lineage path (registerStewardFeedbackSource),
// never directly — the §24.2 precondition.

import { randomUUID } from 'node:crypto';
import {
  type AiAccuracyMetrics,
  type AiCorrection,
  type AiCorrectionAction,
  type AiUseCaseId,
  aiCorrectionSchema,
  computeAccuracyMetrics,
} from '@licio/ai-governance';
import type { AiGovernanceMetrics } from './metrics.js';
import type { AiOutputRecordStore, CorrectionStore } from './stores.js';

export interface CorrectionDeps {
  corrections: CorrectionStore;
  outputRecords: AiOutputRecordStore;
  metrics: AiGovernanceMetrics;
  log: (event: string, meta: Record<string, unknown>) => void;
  now: () => number;
}

export interface RecordCorrectionInput {
  outputId: string;
  useCaseId: AiUseCaseId;
  action: AiCorrectionAction;
  /** The AI output as produced (preserved). */
  originalValue: string;
  /** The corrected value (required for modify; null for confirm/reject). */
  correctedValue: string | null;
  /** `steward:<id>` reference (never a raw identity). */
  stewardRef: string;
  category: string | null;
}

export type CorrectionOutcome =
  | { ok: true; correction: AiCorrection }
  | { ok: false; reason: 'output_not_found' | 'invalid' };

/** Record a steward correction (WS-K.1.3c). Links back to the output record. */
export async function recordCorrection(
  deps: CorrectionDeps,
  input: RecordCorrectionInput,
): Promise<CorrectionOutcome> {
  const output = await deps.outputRecords.get(input.outputId);
  if (output === null) return { ok: false, reason: 'output_not_found' };

  const parsed = aiCorrectionSchema.safeParse({
    correction_id: `corr-${randomUUID()}`,
    output_id: input.outputId,
    use_case_id: input.useCaseId,
    action: input.action,
    original_value: input.originalValue,
    corrected_value: input.correctedValue,
    steward_ref: input.stewardRef,
    category: input.category,
    corrected_at: new Date(deps.now()).toISOString(),
  });
  if (!parsed.success) return { ok: false, reason: 'invalid' };
  const correction = parsed.data;

  await deps.corrections.put(correction);
  // Link the correction to its originating output record (the only permitted
  // mutation on the immutable record).
  await deps.outputRecords.linkCorrection(input.outputId, correction.correction_id);

  deps.metrics.increment('ai.correction.recorded');
  deps.metrics.increment(`ai.correction.recorded.${input.action}`);
  deps.log('ai.correction.recorded', {
    output_id: input.outputId,
    use_case_id: input.useCaseId,
    action: input.action,
  });
  return { ok: true, correction };
}

/** Compute accuracy metrics for a use case from accumulated corrections. */
export async function accuracyMetrics(
  deps: CorrectionDeps,
  useCaseId: AiUseCaseId,
): Promise<AiAccuracyMetrics> {
  const corrections = await deps.corrections.listByUseCase(useCaseId);
  const metrics = computeAccuracyMetrics(
    useCaseId,
    corrections,
    new Date(deps.now()).toISOString(),
  );
  deps.metrics.gauge(`ai.accuracy.agreement.${useCaseId}`, metrics.agreement_rate);
  deps.metrics.gauge(`ai.accuracy.correction.${useCaseId}`, metrics.correction_rate);
  deps.log('ai.accuracy.metric', {
    use_case_id: useCaseId,
    total: metrics.total,
    agreement_rate: metrics.agreement_rate,
    correction_rate: metrics.correction_rate,
  });
  return metrics;
}
