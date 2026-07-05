// SPDX-License-Identifier: AGPL-3.0-or-later
//
// AI output provenance labels (WS-K shared conventions, SPEC §24.1/§24.3).
// Every AI-produced artifact carries a persistent, visible provenance label.
// There are two strata:
//
//   ORIGIN labels — what the machine produced, by use case:
//     machine-generated (summaries), AI-classified (topics),
//     AI-draft (claims), AI-translated (translations).
//   HUMAN labels — what a human did to it (a strict authority UPGRADE):
//     user-edited, steward-confirmed, steward-corrected.
//
// Provenance only ever moves UP this ladder (a steward decision is never
// silently downgraded to "user-edited"), enforced by `applyLabelRevision`
// (../labels.ts). Labels live in BOTH the UI and the persisted metadata, so a
// reader always knows an artifact's provenance and a `steward-corrected`
// version is visibly distinct from a `machine-generated` one (DoD item 5).
import { z } from 'zod';
import type { AiUseCaseId } from './common.js';

/** The machine-origin labels (one per generative/labelling use case). */
export const AI_ORIGIN_LABELS = [
  'machine-generated',
  'AI-classified',
  'AI-draft',
  'AI-translated',
] as const;
export type AiOriginLabel = (typeof AI_ORIGIN_LABELS)[number];

/** The human-revision labels (a strict upgrade over an origin label). */
export const AI_HUMAN_LABELS = ['user-edited', 'steward-confirmed', 'steward-corrected'] as const;
export type AiHumanLabel = (typeof AI_HUMAN_LABELS)[number];

/** Every provenance label. */
export const AI_PROVENANCE_LABELS = [...AI_ORIGIN_LABELS, ...AI_HUMAN_LABELS] as const;
export type AiProvenanceLabel = (typeof AI_PROVENANCE_LABELS)[number];
export const aiProvenanceLabelSchema = z.enum(AI_PROVENANCE_LABELS);

/** The revision actions a human can take on an AI artifact. */
export const AI_LABEL_ACTIONS = ['user_edit', 'steward_confirm', 'steward_correct'] as const;
export type AiLabelAction = (typeof AI_LABEL_ACTIONS)[number];
export const aiLabelActionSchema = z.enum(AI_LABEL_ACTIONS);

/**
 * Authority rank on the provenance ladder. Origin labels are rank 0, a user
 * edit is rank 1, and either steward action is rank 2. Used by the transition
 * rule: a user may not edit (downgrade) a steward decision.
 */
export const LABEL_RANK: Readonly<Record<AiProvenanceLabel, 0 | 1 | 2>> = {
  'machine-generated': 0,
  'AI-classified': 0,
  'AI-draft': 0,
  'AI-translated': 0,
  'user-edited': 1,
  'steward-confirmed': 2,
  'steward-corrected': 2,
};

/** True iff `label` is a machine-origin label (not human-revised). */
export function isMachineGenerated(label: AiProvenanceLabel): label is AiOriginLabel {
  return (AI_ORIGIN_LABELS as readonly string[]).includes(label);
}

/** The canonical machine-origin label for each use case (DoD item 5). */
export const ORIGIN_LABEL_BY_USE_CASE: Readonly<Record<AiUseCaseId, AiOriginLabel | null>> = {
  topic_classification: 'AI-classified',
  claim_extraction: 'AI-draft',
  summarization: 'machine-generated',
  translation: 'AI-translated',
  // Governance summaries are machine-generated summaries (§24.5).
  governance_assistance: 'machine-generated',
  // The debate verdict + rationale shown in the arena is a machine-generated
  // artifact (steward-overrulable), labelled as such (§24.6).
  debate_adjudication: 'machine-generated',
  // These use cases produce no user-facing labelled artifact (MERI handles
  // dedup; embeddings/triage are internal), so they have no origin label.
  duplicate_detection: null,
  toxicity_safety_triage: null,
  embedding_generation: null,
};
