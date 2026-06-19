// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Data lineage service (WS-K.1.1e, SPEC §24.2). Records are immutable and
// append-only; a new dataset version links its predecessor. The hard
// precondition for the WS-K.1.3c fine-tuning path is enforced HERE and at the
// schema/DB CHECK: a user-derived dataset cannot be marked `usable` without a
// `privacy_review_ref`. Steward-correction feedback (WS-K.1.3c) registers as a
// tracked lineage source with provenance and a privacy review reference.
import { type DataLineageRecord, dataLineageRecordSchema } from '@licio/ai-governance';
import type { AiGovernanceMetrics } from './metrics.js';
import type { DataLineageStore } from './stores.js';

export type LineageOutcome =
  | { ok: true; record: DataLineageRecord }
  | {
      ok: false;
      code: 'invalid' | 'exists' | 'predecessor_missing';
      message: string;
    };

export interface LineageDeps {
  lineage: DataLineageStore;
  metrics: AiGovernanceMetrics;
  log: (event: string, meta: Record<string, unknown>) => void;
}

/** Record a lineage entry. The privacy-review precondition is enforced by the
 *  schema refine; a referenced predecessor must already exist. */
export async function recordLineage(deps: LineageDeps, input: unknown): Promise<LineageOutcome> {
  const parsed = dataLineageRecordSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      code: 'invalid',
      message: parsed.error.issues[0]?.message ?? 'invalid lineage record',
    };
  }
  const record = parsed.data;
  if (record.predecessor_dataset_id !== null) {
    const existing = await deps.lineage.list();
    const found = existing.some((r) => r.dataset_id === record.predecessor_dataset_id);
    if (!found) {
      return {
        ok: false,
        code: 'predecessor_missing',
        message: `predecessor dataset "${record.predecessor_dataset_id}" not found`,
      };
    }
  }
  const stored = await deps.lineage.put(record);
  if (stored === null) {
    return { ok: false, code: 'exists', message: 'lineage record already exists (append-only)' };
  }
  deps.metrics.increment('ai.data.lineage.recorded');
  deps.log('data.lineage.recorded', {
    dataset_id: record.dataset_id,
    version: record.version,
    contains_user_derived: record.contains_user_derived,
    privacy_reviewed: record.privacy_review_ref !== null,
  });
  return { ok: true, record: stored };
}

export interface StewardFeedbackSourceInput {
  datasetId: string;
  version: string;
  /** The privacy review that cleared this user-derived feedback (REQUIRED to
   *  be usable). Null records the source but leaves it unusable for training. */
  privacyReviewRef: string | null;
  /** The steward(s)/process that produced the corrections. */
  actor: string;
  predecessorDatasetId: string | null;
  usedBy: string[];
  nowIso: string;
}

/**
 * Register steward-correction feedback as a tracked lineage source (WS-K.1.3c).
 * It is user-derived, so it is usable for training ONLY when a privacy review is
 * referenced — otherwise it is recorded (for provenance) but not usable.
 */
export async function registerStewardFeedbackSource(
  deps: LineageDeps,
  input: StewardFeedbackSourceInput,
): Promise<LineageOutcome> {
  const record: DataLineageRecord = {
    dataset_id: input.datasetId,
    version: input.version,
    source: 'steward-corrected AI outputs',
    consent_basis: 'platform governance approval for steward-correction feedback',
    contains_user_derived: true,
    transformations: [
      {
        transformation: 'aggregation of steward corrections',
        actor: input.actor,
        at: input.nowIso,
      },
      { transformation: 'de-identification', actor: input.actor, at: input.nowIso },
    ],
    privacy_review_ref: input.privacyReviewRef,
    used_by: input.usedBy,
    predecessor_dataset_id: input.predecessorDatasetId,
    // Usable only with a privacy review (the §24.2 precondition).
    usable: input.privacyReviewRef !== null,
    created_at: input.nowIso,
  };
  return recordLineage(deps, record);
}
