// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Frontier comparison (OFFLINE_SPEC §16.2, §17.2, §17.3, WS-R.6.1/R.7.1).  A
// frontier is a compact "how far along am I" summary; comparing local vs remote
// frontiers yields the trust/liveness deltas that MUST move first (§16.1).  All
// pure functions of their inputs.  Room frontiers key by `room_id_hash` and
// revocation frontiers by `(scope, scope_hash)`; an absent counterpart entry
// means "fully behind" (sentinel −1 < any real epoch/size).

import type { CheckpointFrontierV2, RevocationFrontierV2 } from '../schemas/sync.js';

/** Lowercase-hex key for a byte string (frontier map keys are opaque hashes). */
function hexKey(bytes: Uint8Array | undefined): string {
  if (bytes === undefined) return '';
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

/** −1 sentinel for an absent integer field, so "unknown" sorts below any real value. */
function orMissing(value: number | undefined): number {
  return value ?? -1;
}

/** True iff `local` is strictly behind `remote` for the same room (§17.2). */
export function isCheckpointBehind(
  local: CheckpointFrontierV2 | undefined,
  remote: CheckpointFrontierV2,
): boolean {
  if (local === undefined) return true;
  return (
    orMissing(local.latest_tree_size) < orMissing(remote.latest_tree_size) ||
    orMissing(local.latest_policy_epoch) < orMissing(remote.latest_policy_epoch) ||
    orMissing(local.latest_revocation_epoch) < orMissing(remote.latest_revocation_epoch)
  );
}

/**
 * The remote room checkpoint frontiers our local view is behind on — i.e. the
 * rooms for which we should request (want) catch-up.  Deterministic order
 * (sorted by room hash).
 */
export function diffCheckpointFrontiers(
  local: readonly CheckpointFrontierV2[],
  remote: readonly CheckpointFrontierV2[],
): CheckpointFrontierV2[] {
  const localByRoom = new Map<string, CheckpointFrontierV2>();
  for (const f of local) localByRoom.set(hexKey(f.room_id_hash), f);
  return remote
    .filter((r) => isCheckpointBehind(localByRoom.get(hexKey(r.room_id_hash)), r))
    .sort((a, b) => (hexKey(a.room_id_hash) < hexKey(b.room_id_hash) ? -1 : 1));
}

/** Compose the `(scope, scope_hash)` identity key for a revocation frontier (§17.3). */
function revocationKey(f: RevocationFrontierV2): string {
  return `${f.scope}:${hexKey(f.scope_hash)}`;
}

export interface RevocationComparison {
  /** Scopes where the remote is ahead — we want revocations (reason `revocation_gap`). */
  readonly weAreBehind: RevocationFrontierV2[];
  /** Scopes where WE are ahead — the remote is behind; push revocations first (§17.3). */
  readonly remoteIsBehind: RevocationFrontierV2[];
}

/**
 * Compare revocation frontiers per scope (§17.3).  If a peer's revocation
 * frontier is behind ours, we SHOULD prioritize feeding it revocations; if ours
 * is behind, we want theirs.  A scope present on only one side is "behind" for
 * the side that lacks it.
 */
export function compareRevocationFrontiers(
  local: readonly RevocationFrontierV2[],
  remote: readonly RevocationFrontierV2[],
): RevocationComparison {
  const localByScope = new Map<string, RevocationFrontierV2>();
  for (const f of local) localByScope.set(revocationKey(f), f);
  const remoteByScope = new Map<string, RevocationFrontierV2>();
  for (const f of remote) remoteByScope.set(revocationKey(f), f);

  const weAreBehind: RevocationFrontierV2[] = [];
  const remoteIsBehind: RevocationFrontierV2[] = [];

  for (const r of remote) {
    const l = localByScope.get(revocationKey(r));
    if (l === undefined || l.revocation_epoch < r.revocation_epoch) weAreBehind.push(r);
  }
  for (const l of local) {
    const r = remoteByScope.get(revocationKey(l));
    if (r === undefined || r.revocation_epoch < l.revocation_epoch) remoteIsBehind.push(l);
  }
  const byKey = (a: RevocationFrontierV2, b: RevocationFrontierV2) =>
    revocationKey(a) < revocationKey(b) ? -1 : revocationKey(a) > revocationKey(b) ? 1 : 0;
  return {
    weAreBehind: weAreBehind.sort(byKey),
    remoteIsBehind: remoteIsBehind.sort(byKey),
  };
}
