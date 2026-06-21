// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.11.1 — LCAP replication priority + pinning classes and the §21.2 eviction
// order (OFFLINE_SPEC §21.1, §21.2).  PURE policy over `gc_index` candidates: which
// locally-stored objects garbage collection may reclaim, and in what order, under
// storage pressure.  `hard_pin` is NEVER evicted by normal GC (only when the user
// deletes account/app data); user/policy pins outrank the ambient-cache tiers.  The
// I/O — reading `gc_index`, deleting objects, retrying on quota — is WS-R.11.3b; this
// module is the deterministic ordering it consumes.

/** The §21.2 pinning classes, strongest protection first. */
export const PIN_CLASSES = [
  'hard_pin', // local outbox, drafts, own proofs, active cert/capability, fresh revocations
  'user_pin', // saved threads, saved source snapshots, explicit offline packs
  'policy_pin', // room checkpoint frontier, current room policy, recent moderation state
  'cache_pin', // recently viewed subscribed room content
  'courier_pin', // opt-in public replication cache
  'relay_pin', // relay-operator-configured storage
] as const;

export type PinClass = (typeof PIN_CLASSES)[number];

/** A garbage-collection candidate, projected from a `gc_index` row + its record. */
export interface GcCandidate {
  readonly cid: string;
  /** Replication priority class P0–P4 (§21.1); lower = more essential. */
  readonly priority: number;
  /** Scheduling lane (C0 | T1 | E2 | M3 | B4); the §21.2 tiers key on M3/E2. */
  readonly lane: string;
  readonly pinClass: PinClass;
  /** Past the storage mode's freshness threshold (computed by the GC driver). */
  readonly old: boolean;
  /** Whether the candidate's room is currently subscribed (the §21.2 P1 tier). */
  readonly roomSubscribed: boolean;
  /** Whether the candidate sits in the quarantine store (the overflow tier). */
  readonly quarantine: boolean;
  /** Last-access time; ties within a tier evict the least-recently-accessed first. */
  readonly lastAccess: number;
  /** Byte size, for budget-driven selection. */
  readonly size: number;
}

/** `true` iff normal GC must never evict this candidate (§21.2 floor). */
export function isHardPinned(candidate: GcCandidate): boolean {
  return candidate.pinClass === 'hard_pin';
}

/**
 * The §21.2 eviction tier (evict-first = lowest), or `null` when the candidate is
 * not evictable by normal GC.  Order:
 *   0  P4 ambient cache
 *   1  old M3 media
 *   2  old E2 evidence not user-pinned
 *   3  old P1 from unsubscribed rooms
 *   4  quarantine overflow
 *   —  never: hard_pin; and user/policy pins outrank the ambient-cache tiers (0–3).
 */
export function evictionTier(c: GcCandidate): number | null {
  if (c.pinClass === 'hard_pin') return null;
  // User pins outrank ambient cache; policy pins protect room policy/checkpoint state.
  const protectedPin = c.pinClass === 'user_pin' || c.pinClass === 'policy_pin';
  if (!protectedPin) {
    if (c.priority === 4) return 0; // P4 ambient cache
    if (c.lane === 'M3' && c.old) return 1; // old M3 media
    if (c.lane === 'E2' && c.old) return 2; // old E2 evidence not user-pinned
    if (c.priority === 1 && c.old && !c.roomSubscribed) return 3; // old P1, unsubscribed room
  }
  if (c.quarantine) return 4; // quarantine overflow (last normal tier)
  return null; // protected / fresh / subscribed — not evictable by normal GC
}

/**
 * The §21.2 eviction order: the evictable candidates, evict-first, with ties broken
 * by oldest access.  `hard_pin` and otherwise-protected candidates are excluded, so
 * the result is exactly the set normal GC may reclaim, in the order it must do so.
 */
export function evictionOrder(candidates: readonly GcCandidate[]): GcCandidate[] {
  return candidates
    .map((c) => ({ c, tier: evictionTier(c) }))
    .filter((x): x is { c: GcCandidate; tier: number } => x.tier !== null)
    .sort((a, b) => a.tier - b.tier || a.c.lastAccess - b.c.lastAccess)
    .map((x) => x.c);
}

/**
 * Select the prefix of the eviction order whose cumulative `size` frees at least
 * `bytesToFree`.  `hard_pin` is never in the order, so a request larger than the
 * evictable footprint returns the most it can free WITHOUT touching pinned content
 * (the caller surfaces the residual pressure honestly rather than evicting a pin).
 */
export function selectForEviction(
  candidates: readonly GcCandidate[],
  bytesToFree: number,
): GcCandidate[] {
  const selected: GcCandidate[] = [];
  let freed = 0;
  for (const candidate of evictionOrder(candidates)) {
    if (freed >= bytesToFree) break;
    selected.push(candidate);
    freed += candidate.size;
  }
  return selected;
}
