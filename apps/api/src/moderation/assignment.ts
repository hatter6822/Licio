// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-J.2.1d / WS-J.1.3c case + appeal assignment.  Shared load-balancing
// primitive: pick the least-loaded available reviewer, with the appeal-queue
// INDEPENDENCE constraint (never the original decision-maker) layered on top.
// Offline reviewers receive no auto-assignment.
import type { ModerationServices } from './services.js';

/** Pick the least-loaded id from `candidates` by `loadOf` (ties → first). */
export async function pickLeastLoaded(
  candidates: readonly string[],
  loadOf: (userId: string) => Promise<number>,
): Promise<string | null> {
  let best: string | null = null;
  let bestLoad = Number.POSITIVE_INFINITY;
  for (const id of candidates) {
    const load = await loadOf(id);
    if (load < bestLoad) {
      best = id;
      bestLoad = load;
    }
  }
  return best;
}

/**
 * Choose an independent appeal reviewer: an available reviewer other than the
 * original decision-maker, least-loaded.  Returns null when none is available
 * (the appeal stays unassigned → surfaced for senior pickup; never assigned to
 * the original decision-maker — the independence constraint is structural).
 */
export async function assignAppealReviewer(
  services: ModerationServices,
  excludeUserId: string | null,
): Promise<string | null> {
  const available = await services.reviewerStatus.availableIds();
  const candidates = available.filter((id) => id !== excludeUserId);
  if (candidates.length === 0) return null;
  return pickLeastLoaded(candidates, (id) => services.appeals.countOpenByReviewer(id));
}

/** Auto-assign a report case to the least-loaded available reviewer (WS-J.2.1d). */
export async function autoAssignCase(services: ModerationServices): Promise<string | null> {
  const available = await services.reviewerStatus.availableIds();
  if (available.length === 0) return null;
  return pickLeastLoaded(available, (id) => services.cases.countOpenByAssignee(id));
}
