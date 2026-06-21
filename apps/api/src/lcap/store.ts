// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The `LcapServerStore` boundary (WS-R.12.2): the stateful, durable I/O the
// ingestion engine binds — the content-addressed store + the per-room canonical
// acceptance log + the device-sequence index + append-only fork evidence — behind
// an ASYNC interface so the in-memory adapter (here) and the gated Drizzle/Postgres
// adapter (drizzle-store.ts) are interchangeable.  The engine's pure-decision logic
// lives in `@licio/lcap`; this owns only persistence.
//
// The room "log" is an ordered acceptance sequence (append → seq, size, seqOf), not
// a live Merkle tree: the RFC 9162 tree is derivable from the ordered leaves when
// checkpoint issuance lands (a later card), so neither adapter persists tree state.
// CIDs are OPAQUE keys here — the engine verifies them; the store never parses one.

import type { CidKind } from '@licio/lcap';

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
  /** Every room that has at least one accepted record (drives the sync frontier). */
  listRooms(): Promise<readonly string[]>;
  getDeviceClaimant(deviceKeyId: string, deviceSeq: number): Promise<string | undefined>;
  /** Record the FIRST claimant of a (key, seq); a later distinct CID is fork evidence. */
  setDeviceClaimant(deviceKeyId: string, deviceSeq: number, cid: string): Promise<void>;
  appendForkEvidence(evidence: ForkEvidence): Promise<void>;
  listForkEvidence(): Promise<readonly ForkEvidence[]>;
}

/**
 * The in-memory adapter — the project's default (in-memory stores first, then a
 * gated Drizzle adapter).  Network-agnostic: the engine scopes COSE/validation by
 * network; the store is a plain key-value + ordered-log backend.
 */
export class InMemoryLcapServerStore implements LcapServerStore {
  private readonly cas = new Map<string, StoredObject>();
  // Per-room ordered acceptance log: the cid at index i has room sequence i.
  private readonly rooms = new Map<string, string[]>();
  private readonly accepted = new Set<string>();
  private readonly deviceSeqIndex = new Map<string, string>();
  private readonly forkEvidence: ForkEvidence[] = [];

  private static deviceKey(keyId: string, seq: number): string {
    return `${keyId} ${seq}`;
  }

  private roomLog(roomId: string): string[] {
    let log = this.rooms.get(roomId);
    if (!log) {
      log = [];
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

  appendAcceptance(roomId: string, cid: string): Promise<number> {
    const log = this.roomLog(roomId);
    const seq = log.length;
    log.push(cid);
    this.accepted.add(cid);
    return Promise.resolve(seq);
  }

  roomSeqOf(roomId: string, cid: string): Promise<number | undefined> {
    const idx = this.rooms.get(roomId)?.indexOf(cid) ?? -1;
    return Promise.resolve(idx < 0 ? undefined : idx);
  }

  roomSize(roomId: string): Promise<number> {
    return Promise.resolve(this.rooms.get(roomId)?.length ?? 0);
  }

  listRooms(): Promise<readonly string[]> {
    // Only rooms with at least one accepted record (an empty log carries no frontier).
    const rooms: string[] = [];
    for (const [roomId, log] of this.rooms) if (log.length > 0) rooms.push(roomId);
    return Promise.resolve(rooms);
  }

  getDeviceClaimant(deviceKeyId: string, deviceSeq: number): Promise<string | undefined> {
    const key = InMemoryLcapServerStore.deviceKey(deviceKeyId, deviceSeq);
    return Promise.resolve(this.deviceSeqIndex.get(key));
  }

  setDeviceClaimant(deviceKeyId: string, deviceSeq: number, cid: string): Promise<void> {
    const key = InMemoryLcapServerStore.deviceKey(deviceKeyId, deviceSeq);
    if (!this.deviceSeqIndex.has(key)) this.deviceSeqIndex.set(key, cid); // first writer wins
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
