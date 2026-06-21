// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Partial import + quarantine (OFFLINE_SPEC §14.7, §16.11, WS-R.4.3).  Imports
// the renderable core (event/proof/text/capability/checkpoint/thumbnail) while
// skipping unwanted full-media chunks; quarantines records with missing
// dependencies (recording the precise `missing_cids`, retriable once supplied);
// and yields a correct `ObjectStatusV2` for every object in the pack.

import type { ParsedFrame, ParsedPack } from './reader.js';
import type { ObjectStatusV2 } from './status.js';

const FRAME_KIND_TO_CID: Readonly<Record<ParsedFrame['frameKind'], ObjectStatusV2['cid_kind']>> = {
  record_body: 'record',
  proof: 'proof',
  block: 'block',
  chunk: 'chunk',
};

export interface ImportOptions {
  /** Skip full-media chunks / M3 blocks (import only the renderable core). */
  readonly skipMedia?: boolean;
  /** CIDs the importer already holds (satisfy dependencies, suppress re-import). */
  readonly alreadyHave?: ReadonlySet<string>;
}

export interface ImportResult {
  readonly statuses: readonly ObjectStatusV2[];
  /** The objects to store (CID → frame), excluding skipped/quarantined/rejected. */
  readonly imported: ReadonlyMap<string, ParsedFrame>;
}

/** Import a parsed pack, producing a per-object status and the storable set. */
export function importPack(pack: ParsedPack, options: ImportOptions = {}): ImportResult {
  const alreadyHave = options.alreadyHave ?? new Set<string>();
  // A dependency counts as present only if it is a frame whose CID VERIFIED (and will
  // therefore actually be stored) or one already held — a corrupt `rejected_bad_cid`
  // frame must NOT satisfy another object's `deps` (WS-R.4.3), else that object would be
  // imported with a dependency that is in fact absent.
  const present = new Set<string>();
  for (const [cid, frame] of pack.frames) if (frame.cidVerified) present.add(cid);
  const entryByCid = new Map(pack.entries.map((entry) => [entry.cid, entry]));
  const statuses: ObjectStatusV2[] = [];
  const imported = new Map<string, ParsedFrame>();

  for (const [cid, frame] of pack.frames) {
    const entry = entryByCid.get(cid);
    const cidKind = entry?.cid_kind ?? FRAME_KIND_TO_CID[frame.frameKind];

    if (alreadyHave.has(cid)) {
      statuses.push({ cid, cid_kind: cidKind, status: 'already_have' });
      continue;
    }
    if (!frame.cidVerified) {
      statuses.push({ cid, cid_kind: cidKind, status: 'rejected_bad_cid' });
      continue;
    }
    if (options.skipMedia && (cidKind === 'chunk' || entry?.lane === 'M3')) {
      statuses.push({ cid, cid_kind: cidKind, status: 'stored_pending' });
      continue;
    }
    const missing = (entry?.deps ?? []).filter((dep) => !present.has(dep) && !alreadyHave.has(dep));
    if (missing.length > 0) {
      statuses.push({
        cid,
        cid_kind: cidKind,
        status: 'quarantined_missing_dependency',
        missing_cids: missing,
      });
      continue;
    }
    imported.set(cid, frame);
    // Integrity established; trust projection (WS-R.8) raises it further.
    statuses.push({ cid, cid_kind: cidKind, status: 'stored_unverified' });
  }

  return { statuses, imported };
}
