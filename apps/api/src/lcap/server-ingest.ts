// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Server-side LCAP ingestion engine (OFFLINE_SPEC §24.1, WS-R.12.1a/b/c binding).
// Binds the pure `ingestRecord` commit-stage decision + the shared `validate()`
// (@licio/lcap) to the durable `LcapServerStore` boundary (store.ts): a
// content-addressed store (stage 1 — CID-verified durability), the per-room
// canonical acceptance log, an acceptance index (idempotency by `record_cid`), and
// a device-sequence index (authoritative server-side fork detection — never the
// client's local accounting).  The store is in-memory by default; the gated
// Drizzle/Postgres adapter is WS-R.12.2 part 2.  The engine itself holds the
// registered identity state (certs/capabilities/authority keys/revocations) the
// §18.3 validation deps read.
//
// The §24.2 "never emit before validation" rule is preserved end to end: the
// acceptance log is written ONLY when `ingestRecord` returns `appendToRoomLog`,
// which is true only for a freshly-accepted record.

import {
  type CapabilityBundle,
  type CertificateBundle,
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
  resolveIngestionOrder,
  type ValidationResult,
  validate,
  type WantRequestV2,
} from '@licio/lcap';
import {
  type ForkEvidence,
  InMemoryLcapServerStore,
  type LcapContentKind,
  type LcapServerStore,
  type StoredObject,
} from './store.js';

// The content/acceptance state lives behind the LcapServerStore boundary (store.ts).
export type { ForkEvidence, StoredObject };

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

/**
 * A server ingestion engine.  One instance per LCAP network; durable state lives
 * behind the injected `LcapServerStore` (in-memory by default).  Pure-decision
 * logic lives in `@licio/lcap` — this class owns the binding + the registered
 * identity state the §18.3 validation deps read.
 */
export class LcapIngestServer {
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
   * @param store the durable state backend (default in-memory; the gated Drizzle
   *   adapter is WS-R.12.2 part 2).
   */
  constructor(
    private readonly networkId: string,
    private readonly now: () => number = () => Date.now(),
    private readonly store: LcapServerStore = new InMemoryLcapServerStore(networkId),
  ) {}

  /** Stage 1 (R.12.1a): CID-verified durable store; idempotent by CID. */
  async putObject(cid: string, kind: LcapContentKind, bytes: Uint8Array): Promise<boolean> {
    const computed = await cidFor(kind, bytes);
    if (computed !== cid) return false; // rejected_bad_cid — never stored
    await this.store.storeObject(cid, kind, bytes);
    return true;
  }

  hasObject(cid: string): Promise<boolean> {
    return this.store.hasObject(cid);
  }

  /** Read a held object's bytes + kind by CID (§29 content fetch), or undefined. */
  getObject(cid: string): Promise<StoredObject | undefined> {
    return this.store.getObject(cid);
  }

  isAccepted(cid: string): Promise<boolean> {
    return this.store.isAccepted(cid);
  }

  roomSize(roomId: string): Promise<number> {
    return this.store.roomSize(roomId);
  }

  getForkEvidence(): Promise<readonly ForkEvidence[]> {
    return this.store.listForkEvidence();
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

  /**
   * Stages 1-3 (R.12.1a/b/c): store the body (CID-verified), COMPUTE the verdict
   * via `validate()` when one is not supplied (the real path — `input.proofs` +
   * registered identity state), decide via the pure `ingestRecord`, then — only on
   * accept — append to the room's acceptance log + claim the device sequence (both
   * through the store).  Idempotent by `record_cid`; a distinct CID at an
   * already-claimed `(device_key, seq)` yields fork evidence, never a second record.
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
    const alreadyHave = await this.store.isAccepted(input.recordCid);
    const claimant = await this.store.getDeviceClaimant(input.authorDeviceKeyId, input.deviceSeq);
    const deviceForkDetected = claimant !== undefined && claimant !== input.recordCid;

    const outcome = ingestRecord({
      alreadyHave,
      situation: deviceForkDetected ? { validation, deviceForkDetected: true } : { validation },
    });

    let roomSeq: number | undefined;
    if (outcome.appendToRoomLog) {
      roomSeq = await this.store.appendAcceptance(input.roomId, input.recordCid);
      await this.store.setDeviceClaimant(input.authorDeviceKeyId, input.deviceSeq, input.recordCid);
    } else if (alreadyHave) {
      roomSeq = await this.store.roomSeqOf(input.roomId, input.recordCid);
    }

    if (outcome.gossipForkEvidence && claimant !== undefined) {
      await this.store.appendForkEvidence({
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

    // The resolver's `isHeld` predicate is synchronous, but acceptance lives in the
    // (async) store; pre-fetch it for every referenced CID.  Intra-batch dependencies
    // are ordered by the resolver itself, so only EXTERNAL acceptance is queried here.
    const referenced = new Set<string>();
    for (const node of nodes) {
      referenced.add(node.cid);
      for (const req of node.requires) referenced.add(req);
    }
    const acceptedExternally = new Set<string>();
    for (const cid of referenced) {
      if (await this.store.isAccepted(cid)) acceptedExternally.add(cid);
    }

    const resolution = resolveIngestionOrder(nodes, (cid) => acceptedExternally.has(cid));

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
