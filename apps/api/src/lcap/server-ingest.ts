// SPDX-License-Identifier: AGPL-3.0-or-later
//
// In-memory server-side LCAP ingestion (OFFLINE_SPEC §24.1, WS-R.12.1a/c binding).
// Binds the pure `ingestRecord` commit-stage decision (@licio/lcap) to real,
// stateful server I/O: a content-addressed store (stage 1 — CID-verified
// durability), the per-room canonical acceptance log (`RoomLog`), an acceptance
// index (idempotency by `record_cid`), and a device-sequence index (authoritative
// server-side fork detection — never the client's local accounting).  The
// validation stage (R.12.1b) runs in the caller and is supplied as a
// `ValidationResult`; the Postgres binding + the Hono routes (WS-R.12.2/12.4) are
// the remaining I/O cards.  In-memory by design — the project ships in-memory
// stores first, then gated Drizzle adapters.
//
// The §24.2 "never emit before validation" rule is preserved end to end: the room
// log is written ONLY when `ingestRecord` returns `appendToRoomLog`, which is true
// only for a freshly-accepted record.

import {
  type CapabilityBundle,
  type CertificateBundle,
  type CidKind,
  type ConsensusInput,
  checkDependencyGraph,
  cidFor,
  type DetachedProofV2,
  type IdentityChainDeps,
  type IngestionClass,
  type IngestionNode,
  type IngestionReceiptType,
  importPublicKeyCose,
  ingestRecord,
  type ObjectStatusV2,
  RevocationIndex,
  type RevocationRecordV2,
  RoomLog,
  resolveIngestionOrder,
  type ValidationResult,
  validate,
  type WantRequestV2,
} from '@licio/lcap';

/** The Merkle tree algorithm for room logs (RFC 9162, §19.1.1). */
const TREE_ALGORITHM = 'RFC9162_SHA256' as const;

type ContentKind = Extract<CidKind, 'record' | 'proof' | 'block' | 'chunk'>;

interface StoredObject {
  readonly kind: ContentKind;
  readonly bytes: Uint8Array;
  validationState: 'stored_unverified' | 'server_accepted';
}

export interface CommitRecordInput {
  /** The claimed record CID (re-verified against `body` before any store). */
  readonly recordCid: string;
  /** The room whose canonical acceptance log this record joins on accept. */
  readonly roomId: string;
  /** The signing device key id (for authoritative server-side fork detection). */
  readonly authorDeviceKeyId: string;
  /** The per-device sequence number claimed by this record. */
  readonly deviceSeq: number;
  /** The deterministic record bytes (proof bytes excluded; the CID's preimage). */
  readonly body: Uint8Array;
  /**
   * The detached proofs the server holds for this record (the device signature +
   * any authority proofs).  Used to COMPUTE the verdict via `validate()` when
   * `validation` is absent — the real server/route path (R.12.1b).
   */
  readonly proofs?: readonly DetachedProofV2[];
  /** Optional consensus inputs (checkpoint inclusion/consistency; §18.3 steps 11-15). */
  readonly consensus?: ConsensusInput;
  /**
   * A precomputed `validate(record)` outcome.  When omitted, the server computes
   * it from `proofs` + its registered identity state (`validateContribution`);
   * the real ingestion path never supplies this.  A lower-level apply hook.
   */
  readonly validation?: ValidationResult;
  /** Prerequisite CIDs for §24.4 batch ordering (default: none). */
  readonly requires?: readonly string[];
  /** The §24.4 processing class for batch ordering (default: `record`). */
  readonly cls?: IngestionClass;
}

/** The aggregate result of an ordered batch ingestion (§24.1 + §24.4). */
export interface CommitBatchResult {
  /** One §16.11 status per input object (committed, quarantined, or rejected). */
  readonly statuses: readonly ObjectStatusV2[];
  /** The de-duplicated wants for every transitively-absent dependency. */
  readonly wants: readonly WantRequestV2[];
}

export interface CommitRecordResult {
  /** The §16.11 per-object wire status. */
  readonly status: ObjectStatusV2;
  /** Wants for the precise missing dependencies (quarantine-missing only). */
  readonly wants: readonly WantRequestV2[];
  /** The receipt type to authenticate this outcome (§24.5), or `undefined`. */
  readonly receiptType: IngestionReceiptType;
  /** The canonical room sequence, when accepted (or already accepted). */
  readonly roomSeq?: number;
}

/** Append-only fork evidence (§24.3, WS-R.2.4): two distinct CIDs at one (key, seq). */
export interface ForkEvidence {
  readonly authorDeviceKeyId: string;
  readonly deviceSeq: number;
  readonly existingCid: string;
  readonly conflictingCid: string;
}

/**
 * An in-memory server ingestion engine.  One instance per LCAP network; rooms
 * are created lazily on first accept.  Pure-decision logic lives in
 * `@licio/lcap` — this class owns only the stateful I/O it binds.
 */
export class LcapIngestServer {
  private readonly cas = new Map<string, StoredObject>();
  private readonly rooms = new Map<string, RoomLog>();
  private readonly accepted = new Set<string>();
  private readonly deviceSeqIndex = new Map<string, string>();
  private readonly forkEvidence: ForkEvidence[] = [];
  // Registered identity state backing the §18.3 validation deps (R.12.1b).
  private readonly certs = new Map<string, CertificateBundle>();
  private readonly certKeys = new Map<string, CryptoKey>();
  private readonly capabilities = new Map<string, CapabilityBundle>();
  private readonly accountAuthorityKeys = new Map<string, CryptoKey>();
  private readonly roomAuthorityKeys = new Map<string, CryptoKey>();
  private readonly revocations = new RevocationIndex();

  /**
   * @param networkId the LCAP network this server serves.
   * @param now a clock for validation freshness (default `Date.now`; injectable in tests).
   */
  constructor(
    private readonly networkId: string,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Stage 1 (R.12.1a): CID-verified durable store; idempotent by CID. */
  async putObject(cid: string, kind: ContentKind, bytes: Uint8Array): Promise<boolean> {
    const computed = await cidFor(kind, bytes);
    if (computed !== cid) return false; // rejected_bad_cid — never stored
    if (!this.cas.has(cid))
      this.cas.set(cid, { kind, bytes, validationState: 'stored_unverified' });
    return true;
  }

  hasObject(cid: string): boolean {
    return this.cas.has(cid);
  }

  /** Read a held object's bytes + kind by CID (§29 content fetch), or undefined. */
  getObject(cid: string): { readonly kind: ContentKind; readonly bytes: Uint8Array } | undefined {
    const obj = this.cas.get(cid);
    return obj ? { kind: obj.kind, bytes: obj.bytes } : undefined;
  }

  isAccepted(cid: string): boolean {
    return this.accepted.has(cid);
  }

  roomSize(roomId: string): number {
    return this.rooms.get(roomId)?.size ?? 0;
  }

  getForkEvidence(): readonly ForkEvidence[] {
    return this.forkEvidence;
  }

  // --- R.12.1b: registered identity state + the shared `validate()` assembly ----

  /** Register a device certificate (indexed by device key id); imports its key. */
  async registerCertificate(bundle: CertificateBundle): Promise<void> {
    this.certs.set(bundle.certificate.device_key_id, bundle);
    this.certKeys.set(
      bundle.certificate.device_key_id,
      await importPublicKeyCose(bundle.certificate.public_key_cose),
    );
  }

  /** Register a room capability; returns its CID (the resolver + want key). */
  async registerCapability(bundle: CapabilityBundle): Promise<string> {
    const cid = await cidFor('record', bundle.body);
    this.capabilities.set(cid, bundle);
    return cid;
  }

  /** Register an account-authority public key (it signs device certificates). */
  registerAccountAuthorityKey(accountId: string, accountEpoch: number, key: CryptoKey): void {
    this.accountAuthorityKeys.set(`${accountId} ${accountEpoch}`, key);
  }

  /** Register a room-authority public key (it signs capabilities + checkpoints). */
  registerRoomAuthorityKey(roomId: string, policyEpoch: number, key: CryptoKey): void {
    this.roomAuthorityKeys.set(`${roomId} ${policyEpoch}`, key);
  }

  /** Index a revocation (device / capability / account / room_policy / proof). */
  registerRevocation(revocation: RevocationRecordV2): void {
    this.revocations.index(revocation);
  }

  private identityDeps(): IdentityChainDeps {
    return {
      resolveCertificate: (k) => this.certs.get(k),
      resolveCapability: (c) => this.capabilities.get(c),
      resolveAccountAuthorityKey: (a, e) => this.accountAuthorityKeys.get(`${a} ${e}`),
      resolveRoomAuthorityKey: (r, e) => this.roomAuthorityKeys.get(`${r} ${e}`),
      revocations: this.revocations,
    };
  }

  /**
   * Stage 2 (R.12.1b): run the SAME `validate(record)` the client uses, over the
   * server's registered identity state — proofs + authority chain + revocations +
   * capability scopes/quotas + device sequence.  No transport trust: the verdict
   * follows only from cryptography + registered authority, never arrival path.
   */
  async validateContribution(input: {
    readonly recordCid: string;
    readonly body: Uint8Array;
    readonly proofs: readonly DetachedProofV2[];
    readonly consensus?: ConsensusInput;
  }): Promise<ValidationResult> {
    return validate({
      recordCid: input.recordCid,
      body: input.body,
      proofs: input.proofs,
      resolveSignerPublicKey: (id) => Promise.resolve(this.certKeys.get(id)),
      identityDeps: this.identityDeps(),
      ...(input.consensus !== undefined ? { consensus: input.consensus } : {}),
      ctx: { networkId: this.networkId, nowMs: this.now() },
    });
  }

  private room(roomId: string): RoomLog {
    let log = this.rooms.get(roomId);
    if (!log) {
      log = new RoomLog(TREE_ALGORITHM, this.networkId);
      this.rooms.set(roomId, log);
    }
    return log;
  }

  private static deviceKey(keyId: string, seq: number): string {
    return `${keyId} ${seq}`;
  }

  /**
   * Stages 1-3 (R.12.1a/b/c): store the body (CID-verified), COMPUTE the verdict
   * via `validate()` when one is not supplied (the real path — `input.proofs` +
   * registered identity state), decide via the pure `ingestRecord`, then — only on
   * accept — append to the room log, mark `server_accepted`, and claim the device
   * sequence.  Idempotent by `record_cid`; a distinct CID at an already-claimed
   * `(device_key, seq)` yields fork evidence and never a second canonical record.
   */
  async commitRecord(input: CommitRecordInput): Promise<CommitRecordResult> {
    // Stage 1: CID integrity + durable store (never trust the caller's CID claim).
    const stored = await this.putObject(input.recordCid, 'record', input.body);
    if (!stored) {
      return {
        status: { cid: input.recordCid, cid_kind: 'record', status: 'rejected_bad_cid' },
        wants: [],
        receiptType: 'rejected',
      };
    }

    // Stage 2: the verdict — computed server-side from proofs + registered identity
    // state unless a precomputed one was supplied (the lower-level apply hook).
    const validation =
      input.validation ??
      (await this.validateContribution({
        recordCid: input.recordCid,
        body: input.body,
        proofs: input.proofs ?? [],
        ...(input.consensus !== undefined ? { consensus: input.consensus } : {}),
      }));

    // Authoritative (server-side) idempotency + fork detection — independent of
    // the client's local accounting (WS-R.12.3).
    const alreadyHave = this.accepted.has(input.recordCid);
    const dkey = LcapIngestServer.deviceKey(input.authorDeviceKeyId, input.deviceSeq);
    const claimant = this.deviceSeqIndex.get(dkey);
    const deviceForkDetected = claimant !== undefined && claimant !== input.recordCid;

    const outcome = ingestRecord({
      alreadyHave,
      situation: deviceForkDetected ? { validation, deviceForkDetected: true } : { validation },
    });

    let roomSeq: number | undefined;
    if (outcome.appendToRoomLog) {
      roomSeq = await this.room(input.roomId).append(input.recordCid);
      this.accepted.add(input.recordCid);
      this.deviceSeqIndex.set(dkey, input.recordCid);
      const obj = this.cas.get(input.recordCid);
      if (obj) obj.validationState = 'server_accepted';
    } else if (alreadyHave) {
      roomSeq = this.room(input.roomId).seqOf(input.recordCid);
    }

    if (outcome.gossipForkEvidence && claimant !== undefined) {
      this.forkEvidence.push({
        authorDeviceKeyId: input.authorDeviceKeyId,
        deviceSeq: input.deviceSeq,
        existingCid: claimant,
        conflictingCid: input.recordCid,
      });
    }

    const status: ObjectStatusV2 = {
      cid: input.recordCid,
      cid_kind: 'record',
      status: outcome.status,
      ...(outcome.missingCids.length > 0 ? { missing_cids: outcome.missingCids } : {}),
    };
    return {
      status,
      wants: outcome.wants,
      receiptType: outcome.issueReceipt,
      ...(roomSeq !== undefined ? { roomSeq } : {}),
    };
  }

  /**
   * Ingest a received batch in §24.4 processing order: resolve the dependency
   * graph (`resolveIngestionOrder`), commit the satisfiable records in
   * prerequisites-before-dependents order, durably store + quarantine records with
   * absent dependencies (surfacing them as de-duplicated wants), and reject records
   * trapped in a declared-dependency cycle.  A prerequisite counts as held once it
   * has been canonically accepted (this batch or a prior one).
   */
  async commitBatch(inputs: readonly CommitRecordInput[]): Promise<CommitBatchResult> {
    const byCid = new Map<string, CommitRecordInput>();
    const nodes: IngestionNode[] = [];
    for (const input of inputs) {
      if (byCid.has(input.recordCid)) continue;
      byCid.set(input.recordCid, input);
      nodes.push({
        cid: input.recordCid,
        cls: input.cls ?? 'record',
        requires: input.requires ?? [],
      });
    }

    // §27.2 malicious-graph guard, BEFORE any resolution/expansion: a hostile
    // dependency DAG (cycle, fan-out, depth, duplicate deps) aborts the whole
    // import — the graph is untrusted, so no part of it is expanded.
    const guard = checkDependencyGraph(nodes, { audience: 'restricted' });
    if (!guard.ok) {
      return {
        statuses: nodes.map((node) => ({
          cid: node.cid,
          cid_kind: 'record',
          status: guard.code,
        })),
        wants: [],
      };
    }

    const resolution = resolveIngestionOrder(nodes, (cid) => this.accepted.has(cid));

    const statuses: ObjectStatusV2[] = [];
    const wants: WantRequestV2[] = [];
    const wantSeen = new Set<string>();
    const addWant = (cid: string): void => {
      if (wantSeen.has(cid)) return;
      wantSeen.add(cid);
      wants.push({ cid, cid_kind: 'record', reason: 'missing_dependency' });
    };

    // Satisfiable records, parents before children: the full stage-1+3 commit.
    for (const cid of resolution.order) {
      const input = byCid.get(cid);
      if (!input) continue;
      const res = await this.commitRecord(input);
      statuses.push(res.status);
      for (const want of res.wants) addWant(want.cid);
    }

    // Records with absent dependencies: durably store (stage 1), quarantine, want.
    for (const [cid, missing] of resolution.quarantined) {
      const input = byCid.get(cid);
      if (!input) continue;
      const stored = await this.putObject(cid, 'record', input.body);
      if (!stored) {
        statuses.push({ cid, cid_kind: 'record', status: 'rejected_bad_cid' });
        continue;
      }
      statuses.push({
        cid,
        cid_kind: 'record',
        status: 'quarantined_missing_dependency',
        missing_cids: missing,
      });
      for (const dep of missing) addWant(dep);
    }

    // Records trapped in a declared-dependency cycle: malformed, nothing stored.
    for (const cid of resolution.cyclic) {
      statuses.push({ cid, cid_kind: 'record', status: 'rejected_bad_schema' });
    }

    return { statuses, wants };
  }
}
