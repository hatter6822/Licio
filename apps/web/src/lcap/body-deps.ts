// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The §27.1 fan-out cap on a contribution's SIGNED-body BLOCK references, applied IDENTICALLY on
// every client path that derives those refs from a decoded body — the commit path (bundle-import),
// the share/push path (exchange.collectShareableCids), and the export path (bundle-export).  The
// `source_snapshot_cids` array carries NO schema `.max()`, so a malicious body can name thousands of
// CIDs; a naive `[...source_snapshot_cids]` spread would then drive O(n) work — a spread, an awaited
// per-element store query, or an oversized quarantine row — a §27 DoS the unauthenticated table-dep
// guard does not cover.  This helper is the ONE place that bounds them: it reads `.length` BEFORE
// spreading (an over-cap body costs O(maxFanOut), never O(n)) and reports `overCap` so the caller can
// REJECT it — the server's contract (an over-cap fan-out is invalid and must not persist), mirroring
// `LcapIngestServer.indexBodyBlockEdges`.

/** The SIGNED-body block-reference fields of a decoded `contribution_event`. */
export interface BodyBlockRefs {
  readonly body_block_cid?: string | undefined;
  readonly attachment_manifest_cid?: string | undefined;
  readonly source_snapshot_cids?: readonly string[] | undefined;
  readonly target_source_snapshot_cid?: string | undefined;
}

export interface CappedBodyBlockCids {
  /** The body's block-reference CIDs in declaration order (body, attachment, snapshots, target),
   *  bounded at `maxFanOut` — built WITHOUT spreading/iterating `source_snapshot_cids` past the cap. */
  readonly cids: string[];
  /** Whether the DECLARED reference count exceeded `maxFanOut` — the caller should reject/quarantine
   *  such a body so it never persists (the server's §27 contract). */
  readonly overCap: boolean;
}

/**
 * The capped set of a contribution body's block-reference CIDs.  `overCap` mirrors the server's
 * `indexBodyBlockEdges` criterion EXACTLY (body + attachment + `source_snapshot_cids`; the target
 * snapshot is a separate edge there), so the client's reject decision matches the server's — no
 * boundary record the server accepted is falsely rejected here.  `cids` additionally includes the
 * target snapshot ALWAYS (it is a separate block edge, not part of the fan-out-capped set), so an
 * accepted record keeps its full block closure even when its source snapshots exactly fill the cap.
 * Never spreads the (possibly huge) snapshot array: the count is read via `.length` and the build loop
 * `break`s at the cap.  `cids` is therefore bounded by `maxFanOut + 1` (the +1 is the target).
 */
export function cappedBodyBlockCids(refs: BodyBlockRefs, maxFanOut: number): CappedBodyBlockCids {
  const snapshots = refs.source_snapshot_cids ?? [];
  // O(1): read `.length`, never spread.  Matches the server's body/attachment/snapshots criterion
  // EXACTLY (the target snapshot is a separate edge there and is NOT counted toward the cap).
  const declared =
    (refs.body_block_cid !== undefined ? 1 : 0) +
    (refs.attachment_manifest_cid !== undefined ? 1 : 0) +
    snapshots.length;
  const cids: string[] = [];
  const add = (d: string | undefined): void => {
    if (d !== undefined && cids.length < maxFanOut) cids.push(d);
  };
  add(refs.body_block_cid);
  add(refs.attachment_manifest_cid);
  for (const snapshot of snapshots) {
    if (cids.length >= maxFanOut) break; // never iterate past the cap (no O(n) spread)
    add(snapshot);
  }
  // The target snapshot is a SEPARATE block edge (not part of the fan-out-capped body/attachment/
  // source-snapshot set the server bounds), so it must NOT compete for a cap slot — include it
  // unconditionally, or an ACCEPTED record whose source snapshots exactly fill the cap would silently
  // lose its target block dep (then committed without quarantining it / omitted from share+export) (#1).
  if (refs.target_source_snapshot_cid !== undefined) cids.push(refs.target_source_snapshot_cid);
  return { cids, overCap: declared > maxFanOut };
}
