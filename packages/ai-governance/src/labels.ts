// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Provenance-label transitions (WS-K shared conventions, SPEC §24.1). Human
// revision UPGRADES an artifact's label along the authority ladder
// (origin → user-edited → steward decision); it never downgrades. A user may
// edit a machine output or a prior user edit, but not silently overwrite a
// steward decision; a steward may act from any state. This is the one place the
// label state machine lives, so every pipeline (claims, summaries, translations,
// classifications) shares identical provenance semantics.
import { type AiLabelAction, type AiProvenanceLabel, LABEL_RANK } from './schemas/labels.js';

export type LabelRevisionResult =
  | { ok: true; label: AiProvenanceLabel }
  | { ok: false; reason: string };

/**
 * Apply a human revision action to an artifact's current provenance label.
 * Returns the upgraded label, or a typed refusal when the action would
 * downgrade a steward decision (a user editing a steward-confirmed/corrected
 * artifact).
 */
export function applyLabelRevision(
  current: AiProvenanceLabel,
  action: AiLabelAction,
): LabelRevisionResult {
  switch (action) {
    case 'user_edit':
      // A user may edit machine output (rank 0) or a prior user edit (rank 1),
      // but not a steward decision (rank 2).
      if (LABEL_RANK[current] >= 2) {
        return {
          ok: false,
          reason: 'a user edit cannot override a steward decision',
        };
      }
      return { ok: true, label: 'user-edited' };
    case 'steward_confirm':
      return { ok: true, label: 'steward-confirmed' };
    case 'steward_correct':
      return { ok: true, label: 'steward-corrected' };
  }
}
