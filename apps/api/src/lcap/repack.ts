// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.12.4 content-push repacking — the SERVER adapter over the PURE `@licio/lcap`
// `repackHeldObjects` (the same assembly the client P2P responder reuses, so lane/priority/
// privacy derivation lives in ONE place).  This binds the pure reader to the server CAS: a
// held object is the server's `StoredObject` (CID-verified `{ kind, bytes }`), so the adapter
// is a one-line `getObject` shim.

import { type RepackResult, repackHeldObjects as repackHeldObjectsPure } from '@licio/lcap';
import type { LcapIngestServer } from './server-ingest.js';

export type { RepackResult };

/**
 * Assemble a pack of the `wants` the SERVER holds (in request order, budget-bounded), via the
 * pure `@licio/lcap` repack over the server CAS.  See the pure function for the privacy-label /
 * truncation semantics; the server-specific part is only the `getObject` binding.
 */
export async function repackHeldObjects(
  server: LcapIngestServer,
  wants: readonly string[],
  maxBytes: number,
): Promise<RepackResult> {
  return repackHeldObjectsPure(
    async (cid) => {
      const obj = await server.getObject(cid);
      if (!obj) return undefined;
      // Stamp a served RECORD with its canonical room_id_hash (computed from the signed room id over
      // the server's network) — the room is store metadata, not in the body, so the receiver would
      // otherwise land it with roomHash:''.  Other kinds (proof/block) carry no room.
      if (obj.kind === 'record') {
        const roomIdHash = await server.roomIdHashForRecord(obj.bytes);
        if (roomIdHash) return { ...obj, roomIdHash };
      }
      return obj;
    },
    wants,
    maxBytes,
  );
}
