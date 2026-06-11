// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-F.1.1c — story lifecycle state machine. Exhaustively verifies the
// authoritative transition table: every ✅ pair is accepted with the exact
// target state, every other (state, trigger) pair rejects with the typed
// error, and the function is deterministic.
import { describe, expect, it } from 'vitest';
import {
  ACTIVE_LIFECYCLE_STATES,
  INVALID_LIFECYCLE_TRANSITION,
  STORY_LIFECYCLE_STATES,
  STORY_LIFECYCLE_TRANSITIONS,
  STORY_LIFECYCLE_TRIGGERS,
  type StoryLifecycleState,
  type StoryLifecycleTrigger,
  transitionStoryLifecycle,
} from '../utils/story-lifecycle.js';

/** Every ✅ cell of the WS-F.1.1c table, written out independently of the
 *  implementation map so a transcription error in either copy fails here. */
const VALID: Array<[StoryLifecycleState, StoryLifecycleTrigger, StoryLifecycleState]> = [
  ['submitted', 'first_attention', 'gathering_attention'],
  ['submitted', 'low_activity', 'archived'],
  ['gathering_attention', 'sustained_participation', 'deepening'],
  ['gathering_attention', 'low_activity', 'archived'],
  ['deepening', 'scoi_evidence_gap', 'context_needed'],
  ['deepening', 'resolved_cleanly', 'stable'],
  ['deepening', 'low_activity', 'archived'],
  ['context_needed', 'lens_reconciliation', 'bridging'],
  ['context_needed', 'context_added', 'stable'],
  ['context_needed', 'low_activity', 'archived'],
  ['bridging', 'regressed', 'context_needed'],
  ['bridging', 'reconciled', 'stable'],
  ['bridging', 'low_activity', 'archived'],
  ['stable', 'renewed_activity', 'deepening'],
  ['stable', 'low_activity', 'archived'],
  ['archived', 'reactivation', 'deepening'],
];

describe('transitionStoryLifecycle (WS-F.1.1c)', () => {
  it.each(VALID)('accepts %s + %s → %s', (from, trigger, to) => {
    expect(transitionStoryLifecycle(from, trigger)).toEqual({ ok: true, next: to });
  });

  it('rejects every (state, trigger) pair not in the table with the typed code', () => {
    const allowed = new Set(VALID.map(([from, trigger]) => `${from}|${trigger}`));
    let rejected = 0;
    for (const state of STORY_LIFECYCLE_STATES) {
      for (const trigger of STORY_LIFECYCLE_TRIGGERS) {
        if (allowed.has(`${state}|${trigger}`)) continue;
        expect(transitionStoryLifecycle(state, trigger)).toEqual({
          ok: false,
          code: INVALID_LIFECYCLE_TRANSITION,
        });
        rejected += 1;
      }
    }
    // 7 states × 11 triggers − 16 valid cells.
    expect(rejected).toBe(7 * 11 - VALID.length);
  });

  it('reaches context_needed only from deepening (SCOI gap) or bridging (regression)', () => {
    const sources = VALID.filter(([, , to]) => to === 'context_needed').map(([from]) => from);
    expect(sources.sort()).toEqual(['bridging', 'deepening']);
  });

  it('archives from every active state on low_activity, and only on low_activity', () => {
    for (const state of ACTIVE_LIFECYCLE_STATES) {
      expect(transitionStoryLifecycle(state, 'low_activity')).toEqual({
        ok: true,
        next: 'archived',
      });
    }
    expect(transitionStoryLifecycle('archived', 'low_activity').ok).toBe(false);
  });

  it('routes reactivation from archived to deepening', () => {
    expect(transitionStoryLifecycle('archived', 'reactivation')).toEqual({
      ok: true,
      next: 'deepening',
    });
  });

  it('is deterministic: repeated evaluation yields identical results', () => {
    for (const state of STORY_LIFECYCLE_STATES) {
      for (const trigger of STORY_LIFECYCLE_TRIGGERS) {
        expect(transitionStoryLifecycle(state, trigger)).toEqual(
          transitionStoryLifecycle(state, trigger),
        );
      }
    }
  });

  it('drives the full §14.4 happy path end to end', () => {
    const path: StoryLifecycleTrigger[] = [
      'first_attention',
      'sustained_participation',
      'scoi_evidence_gap',
      'lens_reconciliation',
      'reconciled',
      'low_activity',
    ];
    let state: StoryLifecycleState = 'submitted';
    const visited: StoryLifecycleState[] = [state];
    for (const trigger of path) {
      const result = transitionStoryLifecycle(state, trigger);
      expect(result.ok).toBe(true);
      if (result.ok) {
        state = result.next;
        visited.push(state);
      }
    }
    expect(visited).toEqual([
      'submitted',
      'gathering_attention',
      'deepening',
      'context_needed',
      'bridging',
      'stable',
      'archived',
    ]);
  });

  it('exposes a transition map whose targets are all declared states', () => {
    for (const state of STORY_LIFECYCLE_STATES) {
      for (const target of Object.values(STORY_LIFECYCLE_TRANSITIONS[state])) {
        expect(STORY_LIFECYCLE_STATES).toContain(target);
      }
    }
  });
});
