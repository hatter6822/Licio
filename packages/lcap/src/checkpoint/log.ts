// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A pure, in-memory room log (OFFLINE_SPEC §19.1, WS-R.9.1 logic core).  The
// room-log sequence is the canonical acceptance order for a room (distinct from
// creation time).  Appends are idempotent and monotonic; the log computes the
// §19.1.1 Merkle root, inclusion proofs, and consistency proofs over any prefix
// `[0, tree_size)`.  The production server (WS-R.12.2) binds this same logic to
// a Postgres `lcap_room_log`; this class is the testable algorithmic core.

import { parseCid } from '../cid/index.js';
import {
  consistencyProofFromLeafHashes,
  inclusionProofFromLeafHashes,
  leafHash,
  merkleRootFromLeafHashes,
  type TreeAlgorithm,
} from './merkle.js';

export class RoomLog {
  private readonly leafHashes: Uint8Array[] = [];
  private readonly seqByCid = new Map<string, number>();

  constructor(
    readonly algorithm: TreeAlgorithm,
    readonly networkId: string,
  ) {}

  get size(): number {
    return this.leafHashes.length;
  }

  /** Append an accepted record CID at the next sequence; idempotent by CID. */
  async append(recordCid: string): Promise<number> {
    const existing = this.seqByCid.get(recordCid);
    if (existing !== undefined) return existing;
    const seq = this.leafHashes.length;
    const parsed = parseCid(recordCid);
    this.leafHashes.push(await leafHash(parsed.bytes, this.algorithm, this.networkId));
    this.seqByCid.set(recordCid, seq);
    return seq;
  }

  /** The room sequence of an appended record, or `undefined`. */
  seqOf(recordCid: string): number | undefined {
    return this.seqByCid.get(recordCid);
  }

  /** The leaf hash at a sequence index (for proof verification). */
  leafHashAt(index: number): Uint8Array | undefined {
    return this.leafHashes[index];
  }

  /** The Merkle root over the prefix `[0, treeSize)` (defaults to the full log). */
  rootAt(treeSize: number = this.size): Promise<Uint8Array> {
    return merkleRootFromLeafHashes(this.leafHashes.slice(0, treeSize));
  }

  /** The inclusion path for `leafIndex` against the prefix `[0, treeSize)`. */
  inclusionProof(leafIndex: number, treeSize: number = this.size): Promise<Uint8Array[]> {
    return inclusionProofFromLeafHashes(this.leafHashes.slice(0, treeSize), leafIndex);
  }

  /** The consistency proof from `firstSize` to the prefix `[0, secondSize)`. */
  consistencyProof(firstSize: number, secondSize: number = this.size): Promise<Uint8Array[]> {
    return consistencyProofFromLeafHashes(this.leafHashes.slice(0, secondSize), firstSize);
  }
}
