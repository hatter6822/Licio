// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The `LcapServerStore` boundary (WS-R.12.2): the stateful, durable I/O the
// ingestion engine binds — the content-addressed store + the per-room canonical
// acceptance log + the device-sequence index + append-only fork evidence — behind
// an ASYNC interface so the in-memory adapter (here) and the gated Drizzle/Postgres
// adapter (WS-R.12.2 part 2) are interchangeable.  The engine's pure-decision logic
// lives in `@licio/lcap`; this owns only persistence.
//
// The room "log" is exposed as an ordered acceptance sequence (append → seq, size,
// seqOf) rather than a live Merkle tree: the RFC 9162 tree is derivable from the
// ordered leaves when checkpoint issuance lands (a later card), so a Postgres
// adapter persists rows, not tree state.  The in-memory adapter keeps a `RoomLog`.

import { type CidKind, RoomLog } from '@licio/lcap';

/** The Merkle tree algorithm for room logs (RFC 9162, §19.1.1). */
const TREE_ALGORITHM = 'RFC9162_SHA256' as const;

export type LcapContentKind = Extract<CidKind, 'record' | 'proof' | 'block' | 'chunk'>;

export interface StoredObject {
  readonly kind: LcapContentKind;
  readonly bytes: Uint8Array;
}

/** Append-only fork evidence (§24.3, WS-R.2.4): two distinct CIDs at one (key, seq). */
export interface ForkEvidence {
  readonly authorDeviceKeyId: string;
  readonly deviceSeq: number;
  readonly existingCid: string;
  readonly conflictingCid: string;
}

/**
 * The durable state the ingestion engine reads + writes.  Identity state (device
 * certificates, capabilities, authority keys, revocations) is NOT here: it is
 * bounded, carries imported `CryptoKey`s the §18.3 sync resolvers need, and is held
 * in the engine (its persistence is a separate WS-R.12.2 follow-up).
 */
export interface LcapServerStore {
  hasObject(cid: string): Promise<boolean>;
  getObject(cid: string): Promise<StoredObject | undefined>;
  /** Persist a (caller-CID-verified) object; idempotent by CID. */
  storeObject(cid: string, kind: LcapContentKind, bytes: Uint8Array): Promise<void>;
  isAccepted(cid: string): Promise<boolean>;
  /** Append to the room's canonical acceptance log + mark accepted; returns the seq. */
  appendAcceptance(roomId: string, cid: string): Promise<number>;
  /** The room sequence of an already-accepted cid, or `undefined`. */
  roomSeqOf(roomId: string, cid: string): Promise<number | undefined>;
  roomSize(roomId: string): Promise<number>;
  getDeviceClaimant(deviceKeyId: string, deviceSeq: number): Promise<string | undefined>;
  setDeviceClaimant(deviceKeyId: string, deviceSeq: number, cid: string): Promise<void>;
  appendForkEvidence(evidence: ForkEvidence): Promise<void>;
  listForkEvidence(): Promise<readonly ForkEvidence[]>;
}

/**
 * The in-memory adapter — the project's default (in-memory stores first, then a
 * gated Drizzle adapter).  One instance per LCAP network; rooms are created lazily.
 */
export class InMemoryLcapServerStore implements LcapServerStore {
  private readonly cas = new Map<string, StoredObject>();
  private readonly rooms = new Map<string, RoomLog>();
  private readonly accepted = new Set<string>();
  private readonly deviceSeqIndex = new Map<string, string>();
  private readonly forkEvidence: ForkEvidence[] = [];

  constructor(private readonly networkId: string) {}

  private static deviceKey(keyId: string, seq: number): string {
    return `${keyId} ${seq}`;
  }

  private room(roomId: string): RoomLog {
    let log = this.rooms.get(roomId);
    if (!log) {
      log = new RoomLog(TREE_ALGORITHM, this.networkId);
      this.rooms.set(roomId, log);
    }
    return log;
  }

  hasObject(cid: string): Promise<boolean> {
    return Promise.resolve(this.cas.has(cid));
  }

  getObject(cid: string): Promise<StoredObject | undefined> {
    const obj = this.cas.get(cid);
    return Promise.resolve(obj ? { kind: obj.kind, bytes: obj.bytes } : undefined);
  }

  storeObject(cid: string, kind: LcapContentKind, bytes: Uint8Array): Promise<void> {
    if (!this.cas.has(cid)) this.cas.set(cid, { kind, bytes });
    return Promise.resolve();
  }

  isAccepted(cid: string): Promise<boolean> {
    return Promise.resolve(this.accepted.has(cid));
  }

  async appendAcceptance(roomId: string, cid: string): Promise<number> {
    const seq = await this.room(roomId).append(cid);
    this.accepted.add(cid);
    return seq;
  }

  roomSeqOf(roomId: string, cid: string): Promise<number | undefined> {
    return Promise.resolve(this.rooms.get(roomId)?.seqOf(cid));
  }

  roomSize(roomId: string): Promise<number> {
    return Promise.resolve(this.rooms.get(roomId)?.size ?? 0);
  }

  getDeviceClaimant(deviceKeyId: string, deviceSeq: number): Promise<string | undefined> {
    const key = InMemoryLcapServerStore.deviceKey(deviceKeyId, deviceSeq);
    return Promise.resolve(this.deviceSeqIndex.get(key));
  }

  setDeviceClaimant(deviceKeyId: string, deviceSeq: number, cid: string): Promise<void> {
    this.deviceSeqIndex.set(InMemoryLcapServerStore.deviceKey(deviceKeyId, deviceSeq), cid);
    return Promise.resolve();
  }

  appendForkEvidence(evidence: ForkEvidence): Promise<void> {
    this.forkEvidence.push(evidence);
    return Promise.resolve();
  }

  listForkEvidence(): Promise<readonly ForkEvidence[]> {
    return Promise.resolve(this.forkEvidence);
  }
}
