// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-K shared conventions — provenance labels. The label ladder upgrades on human
// revision and never downgrades a steward decision; the per-use-case origin
// labels are correct; machine-origin labels are distinguishable from human ones.
import { describe, expect, it } from 'vitest';
import {
  AI_ORIGIN_LABELS,
  applyLabelRevision,
  isMachineGenerated,
  ORIGIN_LABEL_BY_USE_CASE,
} from '../index.js';

describe('WS-K provenance label transitions', () => {
  it('a user edit upgrades a machine-origin label to user-edited', () => {
    for (const origin of AI_ORIGIN_LABELS) {
      const result = applyLabelRevision(origin, 'user_edit');
      expect(result).toEqual({ ok: true, label: 'user-edited' });
    }
  });

  it('a steward confirm/correct upgrades any label', () => {
    expect(applyLabelRevision('AI-draft', 'steward_confirm')).toEqual({
      ok: true,
      label: 'steward-confirmed',
    });
    expect(applyLabelRevision('user-edited', 'steward_correct')).toEqual({
      ok: true,
      label: 'steward-corrected',
    });
  });

  it('a user may edit a prior user edit', () => {
    expect(applyLabelRevision('user-edited', 'user_edit')).toEqual({
      ok: true,
      label: 'user-edited',
    });
  });

  it('a user may NOT downgrade a steward decision', () => {
    for (const stewardLabel of ['steward-confirmed', 'steward-corrected'] as const) {
      const result = applyLabelRevision(stewardLabel, 'user_edit');
      expect(result.ok).toBe(false);
    }
  });

  it('a steward may re-correct/confirm a steward decision', () => {
    expect(applyLabelRevision('steward-confirmed', 'steward_correct').ok).toBe(true);
    expect(applyLabelRevision('steward-corrected', 'steward_confirm').ok).toBe(true);
  });

  it('isMachineGenerated is true exactly for origin labels', () => {
    expect(isMachineGenerated('machine-generated')).toBe(true);
    expect(isMachineGenerated('AI-classified')).toBe(true);
    expect(isMachineGenerated('user-edited')).toBe(false);
    expect(isMachineGenerated('steward-corrected')).toBe(false);
  });

  it('maps each labelled use case to its origin label', () => {
    expect(ORIGIN_LABEL_BY_USE_CASE.topic_classification).toBe('AI-classified');
    expect(ORIGIN_LABEL_BY_USE_CASE.claim_extraction).toBe('AI-draft');
    expect(ORIGIN_LABEL_BY_USE_CASE.summarization).toBe('machine-generated');
    expect(ORIGIN_LABEL_BY_USE_CASE.translation).toBe('AI-translated');
    expect(ORIGIN_LABEL_BY_USE_CASE.governance_assistance).toBe('machine-generated');
    // Internal use cases produce no user-facing labelled artifact.
    expect(ORIGIN_LABEL_BY_USE_CASE.embedding_generation).toBeNull();
    expect(ORIGIN_LABEL_BY_USE_CASE.duplicate_detection).toBeNull();
    expect(ORIGIN_LABEL_BY_USE_CASE.toxicity_safety_triage).toBeNull();
  });
});
