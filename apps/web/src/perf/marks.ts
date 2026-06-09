// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Interaction-budget performance marks (WS-C.5.1, SPEC §6.10). The PWA interaction
// budgets — thread branch open ≤500ms (cached), composer open ≤300ms, offline
// draft save ≤100ms — are emitted as User Timing marks/measures so Playwright
// traces can assert them in CI as release gates, and so RUM can sample them.

export const INTERACTION_BUDGETS = {
  'branch-open': 500,
  'composer-open': 300,
  'draft-save': 100,
} as const;

export type InteractionName = keyof typeof INTERACTION_BUDGETS;

function supported(): boolean {
  return (
    typeof performance !== 'undefined' &&
    typeof performance.mark === 'function' &&
    typeof performance.measure === 'function'
  );
}

const startMark = (name: InteractionName): string => `licio:${name}:start`;

/** Mark the start of a budgeted interaction. */
export function markInteractionStart(name: InteractionName): void {
  if (!supported()) return;
  performance.mark(startMark(name));
}

/**
 * Measure elapsed time since {@link markInteractionStart} for `name`. Returns the
 * duration in ms, or null if unsupported or the start mark is missing.
 */
export function measureInteraction(name: InteractionName): number | null {
  if (!supported()) return null;
  try {
    const measure = performance.measure(`licio:${name}`, startMark(name));
    return measure.duration;
  } catch {
    return null;
  }
}

/** Whether a measured duration is within the interaction's budget. */
export function isWithinBudget(name: InteractionName, durationMs: number): boolean {
  return durationMs <= INTERACTION_BUDGETS[name];
}
