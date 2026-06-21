// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.12.4 content-push repacking: assemble a response/critical pack of HELD
// objects for a peer's explicit wants (the exchange `response_pack` / pulse
// `critical_pack`).  The server re-derives each object's lane/priority from its
// decoded content + the §15.1.1 kind conventions — these are receiver-re-derived
// scheduling HINTS (§16.7), not trust, so they need not be the original sender's
// exact values; the importer re-verifies every CID and re-derives trust regardless.
// No content metadata is persisted: a held object is repacked from its bytes alone.
//
// Serving held objects by CID is exactly what the §29.4-6 GET content routes already
// do; bundling them changes no exposure.  The pack's `privacy_label` is derived
// conservatively from the served records' own `visibility_scope`.

import {
  decodeAndRouteRecord,
  decodeProof,
  defaultLane,
  type LcapPriority,
  type PackHeaderV2,
  type PackObject,
  writePack,
} from '@licio/lcap';
import type { LcapIngestServer } from './server-ingest.js';
import type { StoredObject } from './store.js';

// A coarse per-frame overhead allowance (frame header + table entry) for budgeting.
const FRAME_OVERHEAD_BYTES = 256;

interface DerivedObject {
  readonly object: PackObject;
  /** True iff this object is a non-public contribution (drives the pack privacy label). */
  readonly sensitive: boolean;
}

/** Re-derive a servable PackObject from a held object's bytes (undefined if undecodable). */
function packObjectFor(cid: string, stored: StoredObject): DerivedObject | undefined {
  switch (stored.kind) {
    case 'record': {
      let record: ReturnType<typeof decodeAndRouteRecord>;
      try {
        record = decodeAndRouteRecord(stored.bytes);
      } catch {
        return undefined;
      }
      // Contribution events carry a priority + visibility; control records
      // (certificate/capability/revocation) are P0/C0 trust material.
      const priority: LcapPriority = record.kind === 'contribution_event' ? record.priority : 0;
      const sensitive =
        record.kind === 'contribution_event' && record.visibility_scope !== 'public';
      return {
        object: {
          cid,
          cidKind: 'record',
          frameKind: 'record_body',
          payload: stored.bytes,
          lane: defaultLane(priority),
          priority,
          recordKind: record.kind,
        },
        sensitive,
      };
    }
    case 'proof': {
      let proof: ReturnType<typeof decodeProof>;
      try {
        proof = decodeProof(stored.bytes);
      } catch {
        return undefined;
      }
      // Proofs ride the trust lane (T1/P1) and link to the record they attest.
      return {
        object: {
          cid,
          cidKind: 'proof',
          frameKind: 'proof',
          payload: stored.bytes,
          lane: 'T1',
          priority: 1,
          providesProofFor: proof.record_cid,
        },
        sensitive: false,
      };
    }
    case 'block':
      return {
        object: {
          cid,
          cidKind: 'block',
          frameKind: 'block',
          payload: stored.bytes,
          lane: 'B4',
          priority: 4,
        },
        sensitive: false,
      };
    case 'chunk':
      return {
        object: {
          cid,
          cidKind: 'chunk',
          frameKind: 'chunk',
          payload: stored.bytes,
          lane: 'B4',
          priority: 4,
        },
        sensitive: false,
      };
  }
}

export interface RepackResult {
  /** The assembled pack, or undefined when no wanted object was held + decodable. */
  readonly pack?: Uint8Array;
  /** The CIDs actually included (a prefix of the held wants, budget-bounded). */
  readonly served: readonly string[];
  /** True iff a held, decodable want was dropped to fit the byte budget. */
  readonly truncated: boolean;
}

/**
 * Assemble a pack of the `wants` the server holds, in request order, greedily up to
 * `maxBytes` (the peer's response budget).  Skips wants the server lacks or cannot
 * decode; reports truncation when a held, decodable want was dropped for budget so
 * the caller can mark the exchange `partial`.  The privacy label is upgraded to
 * `contains_in_room_metadata` if any served record is non-public.
 */
export async function repackHeldObjects(
  server: LcapIngestServer,
  wants: readonly string[],
  maxBytes: number,
): Promise<RepackResult> {
  const objects: PackObject[] = [];
  const served: string[] = [];
  const seen = new Set<string>();
  let bytes = 0;
  let truncated = false;
  let sensitive = false;
  for (const cid of wants) {
    if (seen.has(cid)) continue;
    seen.add(cid);
    const stored = await server.getObject(cid);
    if (!stored) continue; // not held — the peer fetches it elsewhere
    const derived = packObjectFor(cid, stored);
    if (!derived) continue; // undecodable — never repacked
    const projected = bytes + derived.object.payload.length + FRAME_OVERHEAD_BYTES;
    if (projected > maxBytes) {
      // Respect the peer's response budget even for the FIRST want: a tiny advertised
      // budget must not be overrun by a single large held object (it stays fetchable via
      // the resumable GET range routes).  Mark the exchange partial and stop.
      truncated = true;
      break;
    }
    objects.push(derived.object);
    served.push(cid);
    bytes = projected;
    if (derived.sensitive) sensitive = true;
  }
  if (objects.length === 0) return { served: [], truncated };
  const privacyLabel: PackHeaderV2['privacy_label'] = sensitive
    ? 'contains_in_room_metadata'
    : 'public';
  const pack = writePack({
    objects,
    transportProfile: 'https',
    privacyLabel,
    maxUncompressedBytes: Math.max(maxBytes, bytes) + 1024,
  });
  return { pack, served, truncated };
}
