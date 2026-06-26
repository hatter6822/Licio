// SPDX-License-Identifier: AGPL-3.0-or-later
//
// §16.4 / §29.4 content-push repacking (PURE).  Assemble a `response_pack` / `critical_pack`
// of HELD objects for a peer's explicit wants, from a caller-supplied content reader — so BOTH
// the server (`apps/api/src/lcap/repack.ts`) AND the client P2P transports (the courier + the
// WebRTC responder) reuse ONE implementation rather than each re-deriving lane/priority/privacy.
//
// Lane/priority are re-derived from each object's decoded content + the §15.1.1 kind conventions
// — receiver-re-derived scheduling HINTS (§16.7), NOT trust: the importer re-verifies every CID
// and re-derives trust regardless.  Everything is derived from the object's BYTES alone (no
// store/table metadata): for a record that includes its ROOM (`home_room_id`/`room_id`) and its
// dep CIDs (parents / capability / body+attachment blocks), threaded onto the PackObject so the
// receiver lands the record with its real `roomHash` (not '') and quarantines on a missing
// prerequisite — otherwise a just-synced record is invisible to "Sync this room" / room export and
// its block share-closure is empty.  The pack `privacy_label` is derived conservatively from the
// served records' own `visibility_scope` (any non-public record upgrades it).

import type { CidKind } from '../cid/index.js';
import { type PackObject, writePack } from '../pack/index.js';
import { defaultLane, type LcapPriority } from '../priority.js';
import { decodeAndRouteRecord, decodeProof } from '../schemas/codec.js';
import type { PackHeaderV2 } from '../schemas/pack.js';

/** A held content object served from a store: its CID kind + verifiable bytes. */
export interface HeldObject {
  readonly kind: CidKind;
  readonly bytes: Uint8Array;
}

/** Reads a held object by CID, or `undefined` when not held — the only I/O `repackHeldObjects`
 *  performs, so the same pure assembly serves the server CAS and the client `lcap_v2` store. */
export type HeldObjectReader = (cid: string) => Promise<HeldObject | undefined>;

export interface RepackResult {
  /** The assembled pack, or undefined when no wanted object was held + decodable. */
  readonly pack?: Uint8Array;
  /** The CIDs actually included (a prefix of the held wants, budget-bounded). */
  readonly served: readonly string[];
  /** True iff a held, decodable want was dropped to fit the byte budget. */
  readonly truncated: boolean;
}

// A coarse per-frame overhead allowance (frame header + table entry) for budgeting.
const FRAME_OVERHEAD_BYTES = 256;

interface DerivedObject {
  readonly object: PackObject;
  /** True iff this object is a non-public record (drives the pack privacy label). */
  readonly sensitive: boolean;
}

/** The room + dep CIDs a record references, from its SIGNED body — so the repacked PackObject lands
 *  the record with its real room + prerequisites (a missing one then quarantines on the receiver). */
function recordRefs(record: ReturnType<typeof decodeAndRouteRecord>): {
  roomId?: string;
  deps: string[];
} {
  const deps: string[] = [];
  if (record.kind === 'contribution_event') {
    // NOTE: `capability_cid` is deliberately NOT a dep — the §18.3 validator resolves the capability
    // from registered identity state, not as a `requires` prerequisite record; declaring it as a dep
    // would make the server import require the capability be ACCEPTED first (it never is), stranding
    // the contribution.  Parents/prev/replaces/target + the body's blocks ARE the structural deps.
    if (record.prev_device_record_cid) deps.push(record.prev_device_record_cid);
    if (record.replaces_record_cid) deps.push(record.replaces_record_cid);
    if (record.target_record_cid) deps.push(record.target_record_cid);
    if (record.thread_root_cid) deps.push(record.thread_root_cid);
    for (const parent of record.parent_record_cids ?? []) deps.push(parent);
    if (record.body_block_cid) deps.push(record.body_block_cid);
    if (record.attachment_manifest_cid) deps.push(record.attachment_manifest_cid);
    for (const snapshot of record.source_snapshot_cids ?? []) deps.push(snapshot);
    if (record.target_source_snapshot_cid) deps.push(record.target_source_snapshot_cid);
    return { roomId: record.home_room_id, deps };
  }
  if (record.kind === 'room_capability') return { roomId: record.room_id, deps };
  return { deps };
}

/** Re-derive a servable PackObject from a held object's bytes (undefined if undecodable). */
function packObjectFor(cid: string, held: HeldObject): DerivedObject | undefined {
  switch (held.kind) {
    case 'record': {
      let record: ReturnType<typeof decodeAndRouteRecord>;
      try {
        record = decodeAndRouteRecord(held.bytes);
      } catch {
        return undefined;
      }
      // Contribution events carry a priority + visibility; control records
      // (certificate/capability/revocation) are P0/C0 trust material.
      const priority: LcapPriority = record.kind === 'contribution_event' ? record.priority : 0;
      // ANY record kind with a non-public visibility_scope (contribution_event AND room_capability)
      // upgrades the pack privacy label — never label restricted content as plain public.
      const sensitive = 'visibility_scope' in record && record.visibility_scope !== 'public';
      const { roomId, deps } = recordRefs(record);
      return {
        object: {
          cid,
          cidKind: 'record',
          frameKind: 'record_body',
          payload: held.bytes,
          lane: defaultLane(priority),
          priority,
          recordKind: record.kind,
          ...(deps.length > 0 ? { deps } : {}),
          ...(roomId !== undefined ? { roomIdHash: new TextEncoder().encode(roomId) } : {}),
        },
        sensitive,
      };
    }
    case 'proof': {
      let proof: ReturnType<typeof decodeProof>;
      try {
        proof = decodeProof(held.bytes);
      } catch {
        return undefined;
      }
      // Proofs ride the trust lane (T1/P1) and link to the record they attest.
      return {
        object: {
          cid,
          cidKind: 'proof',
          frameKind: 'proof',
          payload: held.bytes,
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
          payload: held.bytes,
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
          payload: held.bytes,
          lane: 'B4',
          priority: 4,
        },
        sensitive: false,
      };
  }
}

/**
 * Assemble a pack of the `wants` the reader holds, in request order, greedily up to `maxBytes`
 * (the peer's response budget).  Skips wants the reader lacks or cannot decode; reports
 * truncation when a held, decodable want was dropped for budget so the caller can mark the
 * exchange `partial`.  The privacy label is upgraded to `contains_in_room_metadata` if any served
 * record is non-public.
 */
export async function repackHeldObjects(
  getObject: HeldObjectReader,
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
    const held = await getObject(cid);
    if (!held) continue; // not held — the peer fetches it elsewhere
    const derived = packObjectFor(cid, held);
    if (!derived) continue; // undecodable — never repacked
    const projected = bytes + derived.object.payload.length + FRAME_OVERHEAD_BYTES;
    if (projected > maxBytes) {
      // Respect the peer's response budget even for the FIRST want: a tiny advertised budget must
      // not be overrun by a single large held object (it stays fetchable via the resumable GET
      // range routes).  Mark the exchange partial and stop.
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
