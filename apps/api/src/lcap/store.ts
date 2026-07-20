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

/**
 * A record's export-closure edge kind: a proof that attests it, a block it references, or an
 * identity record it needs to validate (its cited capability / the signer's device certificate).
 */
export type RecordEdgeRelation = 'proof' | 'block' | 'identity';

export interface StoredObject {
  readonly kind: LcapContentKind;
  readonly bytes: Uint8Array;
}

/** A capability's aggregate quotas (§11.3) the accept gate enforces across offline events. */
export interface CapabilityQuotaLimits {
  /** The stable grant id (`capability_id`) the usage is accounted against. */
  readonly capabilityId: string;
  /** §18.3 step 9 `max_offline_events`: the total events this capability may author. */
  readonly maxEvents: number;
  /** §18.3 step 9 `max_total_payload_bytes`: the total event-body bytes it may author. */
  readonly maxTotalBytes: number;
  /** §18.3 step 9 `max_media_bytes`: the total referenced media-block bytes it may bring in. */
  readonly maxMediaBytes: number;
}

/** The outcome of a quota-gated accept: the room seq, or the first aggregate quota violated. */
export type AcceptContributionResult =
  | { readonly ok: true; readonly seq: number }
  | {
      readonly ok: false;
      readonly reason: 'offline_event_quota' | 'total_payload_quota' | 'media_payload_quota';
    };

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
  /**
   * Append to the room's canonical acceptance log + mark accepted; returns the seq.
   * IDEMPOTENT: re-appending an already-accepted cid returns its EXISTING seq (never a
   * second leaf).  The per-room seq is allocated ATOMICALLY, so concurrent accepts receive
   * distinct, gap-free sequences and the returned seq is always the cid's real position —
   * never a phantom seq for a record absent from the log.
   */
  appendAcceptance(roomId: string, cid: string): Promise<number>;
  /**
   * Accept a contribution into the room log WHILE enforcing its capability's aggregate
   * quotas, ATOMICALLY (§11.3 / §18.3 step 9).  IDEMPOTENT by `cid`: a re-accept returns the
   * existing seq and NEVER re-debits the capability.  For a fresh record the capability's
   * running (events, total_bytes, media_bytes) is checked against the quotas and — only if
   * within budget — incremented in the SAME atomic step as the room-log append, so the budget
   * is debited exactly once per accepted record and concurrent accepts cannot exceed it.
   * `mediaBytes` is the summed stored size of the contribution's referenced media blocks
   * (computed by the caller from the record's block edges present at accept).  On a quota
   * violation nothing is appended and nothing is debited; the first quota breached is returned.
   */
  acceptContribution(
    roomId: string,
    cid: string,
    eventBytes: number,
    mediaBytes: number,
    quota: CapabilityQuotaLimits,
  ): Promise<AcceptContributionResult>;
  /** The room sequence of an already-accepted cid, or `undefined`. */
  roomSeqOf(roomId: string, cid: string): Promise<number | undefined>;
  roomSize(roomId: string): Promise<number>;
  /** Every room that has at least one accepted record (drives the sync frontier). */
  listRooms(): Promise<readonly string[]>;
  /** The room's accepted CIDs in canonical acceptance order (the §19.1 Merkle leaves). */
  roomLog(roomId: string): Promise<readonly string[]>;
  getDeviceClaimant(deviceKeyId: string, deviceSeq: number): Promise<string | undefined>;
  /**
   * ATOMICALLY claim a (key, seq) for `cid` and return the WINNING claimant: `cid` itself
   * if it won (or is already the claimant — idempotent), otherwise the cid that claimed it
   * first.  The first claimant wins permanently; a return value other than `cid` means THIS
   * record is a device fork (it must not append to the room log).  This single atomic
   * operation replaces a racy read-then-write so two concurrent records for one (key, seq)
   * can never both be accepted.
   */
  claimDeviceSeq(deviceKeyId: string, deviceSeq: number, cid: string): Promise<string>;
  appendForkEvidence(evidence: ForkEvidence): Promise<void>;
  listForkEvidence(): Promise<readonly ForkEvidence[]>;
  /** Index a record→proof / record→block edge for room-export closure (idempotent). */
  indexRecordEdge(
    recordCid: string,
    relatedCid: string,
    relation: RecordEdgeRelation,
  ): Promise<void>;
  /** The CIDs related to `recordCid` by `relation` (its proofs or its referenced blocks). */
  recordEdges(recordCid: string, relation: RecordEdgeRelation): Promise<readonly string[]>;
  /**
   * The REVERSE edge: every record that references `relatedCid` under `relation` (the inverse of
   * {@link recordEdges}).  The §29 public-serve gate uses it to resolve a block/proof CID to its
   * owning record(s) — a block is public-servable iff SOME owning record is public — so a non-public
   * record's body/media block can never be served by CID over the public read/exchange surface.
   */
  recordsReferencing(relatedCid: string, relation: RecordEdgeRelation): Promise<readonly string[]>;
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
  // capability_id → its running aggregate usage (the §18.3 step 9 budget accounting).
  private readonly capabilityUsage = new Map<
    string,
    { events: number; totalBytes: number; mediaBytes: number }
  >();
  private readonly deviceSeqIndex = new Map<string, string>();
  private readonly forkEvidence: ForkEvidence[] = [];
  // Record-export closure edges, keyed by `${relation} ${recordCid}`.
  private readonly recordClosure = new Map<string, Set<string>>();
  // The REVERSE of `recordClosure`, keyed by `${relation} ${relatedCid}` → owning record CIDs.
  private readonly recordClosureReverse = new Map<string, Set<string>>();

  private static deviceKey(keyId: string, seq: number): string {
    return `${keyId} ${seq}`;
  }

  private static edgeKey(relation: RecordEdgeRelation, recordCid: string): string {
    return `${relation} ${recordCid}`;
  }

  private ensureRoomLog(roomId: string): string[] {
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
    const log = this.ensureRoomLog(roomId);
    const existing = log.indexOf(cid);
    if (existing >= 0) return Promise.resolve(existing); // idempotent: keep the original seq
    const seq = log.length;
    log.push(cid);
    this.accepted.add(cid);
    return Promise.resolve(seq);
  }

  acceptContribution(
    roomId: string,
    cid: string,
    eventBytes: number,
    mediaBytes: number,
    quota: CapabilityQuotaLimits,
  ): Promise<AcceptContributionResult> {
    const log = this.ensureRoomLog(roomId);
    const existing = log.indexOf(cid);
    if (existing >= 0) return Promise.resolve({ ok: true, seq: existing }); // idempotent, no re-debit
    const usage = this.capabilityUsage.get(quota.capabilityId) ?? {
      events: 0,
      totalBytes: 0,
      mediaBytes: 0,
    };
    if (usage.events + 1 > quota.maxEvents) {
      return Promise.resolve({ ok: false, reason: 'offline_event_quota' });
    }
    if (usage.totalBytes + eventBytes > quota.maxTotalBytes) {
      return Promise.resolve({ ok: false, reason: 'total_payload_quota' });
    }
    if (usage.mediaBytes + mediaBytes > quota.maxMediaBytes) {
      return Promise.resolve({ ok: false, reason: 'media_payload_quota' });
    }
    const seq = log.length;
    log.push(cid);
    this.accepted.add(cid);
    this.capabilityUsage.set(quota.capabilityId, {
      events: usage.events + 1,
      totalBytes: usage.totalBytes + eventBytes,
      mediaBytes: usage.mediaBytes + mediaBytes,
    });
    return Promise.resolve({ ok: true, seq });
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

  roomLog(roomId: string): Promise<readonly string[]> {
    // A copy so the caller can never mutate the canonical acceptance order.
    return Promise.resolve([...(this.rooms.get(roomId) ?? [])]);
  }

  getDeviceClaimant(deviceKeyId: string, deviceSeq: number): Promise<string | undefined> {
    const key = InMemoryLcapServerStore.deviceKey(deviceKeyId, deviceSeq);
    return Promise.resolve(this.deviceSeqIndex.get(key));
  }

  claimDeviceSeq(deviceKeyId: string, deviceSeq: number, cid: string): Promise<string> {
    const key = InMemoryLcapServerStore.deviceKey(deviceKeyId, deviceSeq);
    const existing = this.deviceSeqIndex.get(key);
    if (existing !== undefined) return Promise.resolve(existing); // first claimant wins
    this.deviceSeqIndex.set(key, cid);
    return Promise.resolve(cid);
  }

  appendForkEvidence(evidence: ForkEvidence): Promise<void> {
    this.forkEvidence.push(evidence);
    return Promise.resolve();
  }

  listForkEvidence(): Promise<readonly ForkEvidence[]> {
    // A copy so the caller can never mutate the canonical evidence log (matches roomLog + the Drizzle adapter's fresh array).
    return Promise.resolve([...this.forkEvidence]);
  }

  indexRecordEdge(
    recordCid: string,
    relatedCid: string,
    relation: RecordEdgeRelation,
  ): Promise<void> {
    const key = InMemoryLcapServerStore.edgeKey(relation, recordCid);
    let set = this.recordClosure.get(key);
    if (!set) {
      set = new Set();
      this.recordClosure.set(key, set);
    }
    set.add(relatedCid);
    // Maintain the reverse index for the §29 public-serve visibility resolution.
    const rkey = InMemoryLcapServerStore.edgeKey(relation, relatedCid);
    let rset = this.recordClosureReverse.get(rkey);
    if (!rset) {
      rset = new Set();
      this.recordClosureReverse.set(rkey, rset);
    }
    rset.add(recordCid);
    return Promise.resolve();
  }

  recordEdges(recordCid: string, relation: RecordEdgeRelation): Promise<readonly string[]> {
    const set = this.recordClosure.get(InMemoryLcapServerStore.edgeKey(relation, recordCid));
    return Promise.resolve(set ? [...set] : []);
  }

  recordsReferencing(relatedCid: string, relation: RecordEdgeRelation): Promise<readonly string[]> {
    const set = this.recordClosureReverse.get(
      InMemoryLcapServerStore.edgeKey(relation, relatedCid),
    );
    return Promise.resolve(set ? [...set] : []);
  }
}
