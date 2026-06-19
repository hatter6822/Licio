// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Audit-sensitive output record writer (WS-K.1.1f, SPEC §24.2/§28.2). Every
// audit-sensitive AI output (classification, claim draft, summary, translation,
// governance summary, triage flag) writes an immutable AIOutputRecord here. The
// config hash is a SHA-256 over the canonical (key-sorted) JSON of the model
// configuration — computed server-side (node:crypto) over the browser-safe
// canonical serializer from @licio/ai-governance, so the same config always
// hashes identically and a tampered config is detectable.
import { createHash, randomUUID } from 'node:crypto';
import {
  type AiOutputRecord,
  type AiUseCaseId,
  aiOutputRecordSchema,
  canonicalJson,
} from '@licio/ai-governance';
import type { AiOutputRecordStore } from './stores.js';

/** SHA-256 hex of the canonical JSON of `config`. */
export function configHash(config: unknown): string {
  return createHash('sha256').update(canonicalJson(config)).digest('hex');
}

export interface RecordOutputInput {
  modelName: string;
  modelVersion: string;
  promptTemplateId: string;
  /** The full model configuration (hashed into config_hash). */
  config: unknown;
  inputRefs: string[];
  outputRef: string;
  useCaseId: AiUseCaseId;
  nowIso: string;
}

/** Build, validate, and persist an immutable AIOutputRecord. */
export async function recordAiOutput(
  store: AiOutputRecordStore,
  input: RecordOutputInput,
): Promise<AiOutputRecord> {
  const record = aiOutputRecordSchema.parse({
    output_id: `out:${randomUUID()}`,
    model_name: input.modelName,
    model_version: input.modelVersion,
    prompt_template_id: input.promptTemplateId,
    config_hash: configHash(input.config),
    input_refs: input.inputRefs,
    output_ref: input.outputRef,
    use_case_id: input.useCaseId,
    correction_ref: null,
    timestamp: input.nowIso,
  } satisfies AiOutputRecord);
  const stored = await store.put(record);
  // A fresh uuid output_id cannot collide; treat a null as a store fault.
  if (stored === null) throw new Error('AIOutputRecord id collision');
  return stored;
}
