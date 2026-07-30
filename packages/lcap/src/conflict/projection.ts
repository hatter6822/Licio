// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Deterministic visible-thread projection (OFFLINE_SPEC §25.2, WS-R.13.2).
// Layers the per-record trust state and the local safety mode over the
// append-only edit/tombstone projection (WS-R.2.2).  Conflicting evidence
// remains INSPECTABLE (flagged, never dropped); the safer/stricter state is
// shown by default; local safety mode can further restrict but never silently
// delete.  Deterministic: same accepted set + trust + policy ⇒ identical output
// across clients.

import {
  type ProjectedContribution,
  reduceThreadProjection,
  type ThreadRecord,
  type UnresolvedSupersede,
} from '../records/projection.js';
import type { TrustState } from '../validate/states.js';

export type SafetyMode = 'normal' | 'strict';

/** Trust states shown by default in strict safety mode (authorized and above). */
const STRICT_VISIBLE: ReadonlySet<TrustState> = new Set<TrustState>([
  'authorized_provisional',
  'stale_authorized',
  'server_stored',
  'server_accepted',
  'checkpointed',
  'witnessed',
]);

export interface VisibleContribution extends ProjectedContribution {
  readonly trustState: TrustState;
  /** A fork/sequence/checkpoint conflict touches this contribution. */
  readonly conflicting: boolean;
  /** Restricted by the local safety mode (still inspectable, never deleted). */
  readonly restrictedBySafety: boolean;
  /** Shown by default (not tombstoned and not safety-restricted). */
  readonly shownByDefault: boolean;
}

export interface ProjectVisibleOptions {
  /** Resolve the trust state of the visible version of a contribution. */
  readonly trustOf: (cid: string) => TrustState;
  /** CIDs touched by a conflict (device/checkpoint fork) — surfaced, not dropped. */
  readonly conflictingCids?: ReadonlySet<string>;
  readonly safetyMode?: SafetyMode;
}

/**
 * The visible thread, plus the refusals that belong to no contribution in it.
 *
 * Carried through this layer for the reason the header states as its own guarantee —
 * "conflicting evidence remains INSPECTABLE (flagged, never dropped)".  Dropping
 * `unresolvedSupersedes` here would have re-broken it one layer above the fix.
 */
export interface VisibleThread {
  readonly contributions: readonly VisibleContribution[];
  readonly unresolvedSupersedes: readonly UnresolvedSupersede[];
}

/** Project the visible thread with trust + safety overlays. */
export function projectVisibleThread(
  records: readonly ThreadRecord[],
  options: ProjectVisibleOptions,
): VisibleThread {
  const safetyMode = options.safetyMode ?? 'normal';
  const conflicting = options.conflictingCids ?? new Set<string>();
  const projection = reduceThreadProjection(records);
  const contributions = projection.contributions.map((projected) => {
    const trustState = options.trustOf(projected.visibleCid);
    const isConflicting =
      conflicting.has(projected.visibleCid) ||
      conflicting.has(projected.rootCid) ||
      projected.editChain.some((cid) => conflicting.has(cid));
    const restrictedBySafety = safetyMode === 'strict' && !STRICT_VISIBLE.has(trustState);
    return {
      ...projected,
      trustState,
      conflicting: isConflicting,
      restrictedBySafety,
      // A tombstoned or safety-restricted item is not shown by default, but
      // remains in the projection (inspectable) — never silently discarded.
      shownByDefault: !projected.hidden && !restrictedBySafety,
    };
  });
  return { contributions, unresolvedSupersedes: projection.unresolvedSupersedes };
}
