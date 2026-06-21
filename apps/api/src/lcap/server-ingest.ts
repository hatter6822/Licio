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
  buildPulse,
  buildPulseResponse,
  type CapabilityBundle,
  type CertificateBundle,
  type CheckpointFrontierV2,
  type ConsensusInput,
  type CryptoSuiteId,
  checkCap,
  checkDependencyGraph,
  cidFor,
  DEFAULT_BUDGET,
  type DetachedProofV2,
  detachedProofV2Schema,
  type ExportAuthorizationResult,
  type ExportRequestV2,
  encodeWithSchema,
  type GraphGuardNode,
  type GraphGuardResult,
  graphLimitsFromCaps,
  type IdentityChainDeps,
  type IngestionClass,
  type IngestionNode,
  type IngestionReceiptType,
  importPublicKeyCose,
  ingestRecord,
  type ObjectStatusV2,
  type PulseResponseV2,
  type ResourceCaps,
  type RevocationAuthorityBinding,
  type RevocationFrontierV2,
  RevocationIndex,
  type RevocationRecordV2,
  RoomLog,
  resolveIngestionOrder,
  roomIdHash,
  SERVER_CAPS,
  type SyncPulseV2,
  type TreeAlgorithm,
  type ValidationResult,
  validate,
  verifyDeviceCertificate,
  verifyExportAuthorization,
  verifyRevocationAuthority,
  type WantRequestV2,
} from '@licio/lcap';
import {
  type ForkEvidence,
  InMemoryLcapServerStore,
  type LcapContentKind,
  type LcapServerStore,
  type RecordEdgeRelation,
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
  // Authority keys indexed by their COSE `signer_key_id` + the scope/id they govern, so a
  // revocation's `authority_signature` proof can be resolved by signer id and scope-checked
  // (a revocation carries no authority epoch — the signer id identifies the exact key).
  private readonly authoritySigners = new Map<string, RevocationAuthorityBinding>();
  // device_key_id → its certificate's record CID, so a contribution's §29.8 export closure can
  // include the signer cert (resolvable only by device key id, not from the contribution body).
  private readonly deviceCertCids = new Map<string, string>();
  private readonly revocations = new RevocationIndex();

  /**
   * @param networkId the LCAP network this server serves.
   * @param now a clock for validation freshness + the §27.1 import CPU-time guard
   *   (default `Date.now`; injectable in tests).
   * @param store the durable state backend (default in-memory; the gated Drizzle
   *   adapter is WS-R.12.2 part 2).
   * @param caps the §27.1 resource caps profile (default the server ceiling; an
   *   old-phone relay passes `OLD_PHONE_CAPS`).  Never disable-able.
   */
  constructor(
    private readonly networkId: string,
    private readonly now: () => number = () => Date.now(),
    private readonly store: LcapServerStore = new InMemoryLcapServerStore(),
    private readonly caps: ResourceCaps = SERVER_CAPS,
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

  /** Index a record→proof / record→block edge for the §29.8 room-export closure. */
  indexRecordEdge(
    recordCid: string,
    relatedCid: string,
    relation: RecordEdgeRelation,
  ): Promise<void> {
    return this.store.indexRecordEdge(recordCid, relatedCid, relation);
  }

  /**
   * The §29.8 export closure for a room: its accepted records in acceptance order, each
   * preceded by the IDENTITY it needs to validate (its cited capability + the signer's device
   * certificate, each with their authority proofs) and followed by its own proofs then its
   * referenced blocks — so the importer meets a record's trust material + media and can
   * VALIDATE the contribution, not merely store it (a self-contained, re-validatable export).
   * De-duplicated; only the CIDs — the route repacks the held bytes.
   */
  async exportRoomClosureCids(roomId: string): Promise<string[]> {
    const records = await this.store.roomLog(roomId);
    const out: string[] = [];
    const seen = new Set<string>();
    const push = (cid: string): void => {
      if (!seen.has(cid)) {
        seen.add(cid);
        out.push(cid);
      }
    };
    const pushWithProofs = async (cid: string): Promise<void> => {
      push(cid);
      for (const proofCid of await this.store.recordEdges(cid, 'proof')) push(proofCid);
    };
    for (const recordCid of records) {
      // Identity closure FIRST (capability + signer cert + their authority proofs), then the
      // record + its proofs, then its blocks.  A shared capability/cert is emitted once.
      for (const identityCid of await this.store.recordEdges(recordCid, 'identity')) {
        await pushWithProofs(identityCid);
      }
      await pushWithProofs(recordCid);
      for (const blockCid of await this.store.recordEdges(recordCid, 'block')) push(blockCid);
    }
    return out;
  }

  // --- R.12.1b: registered identity state + the shared `validate()` assembly ----

  /**
   * Register a device certificate (indexed by device key id) AFTER verifying its
   * account-authority proof — never on an unverified cert.  The signer-key resolver
   * (`validate()` Stage 1) reads `certKeys` to check a contribution's OWN signature, so a
   * cert that overwrote `certKeys[device_key_id]` with attacker COSE bytes would make the
   * victim's valid signatures fail verification (impersonation / DoS).  We resolve the
   * account-authority key for the cert's `(account_id, account_epoch)` and require the
   * `authority_signature` proof to verify over the cert body within its validity window;
   * only then is the device key imported.  An unknown authority key or a failed proof
   * leaves any existing (already-verified) entry UNTOUCHED — an unverified cert can never
   * displace a known device key.  Returns whether the cert was registered.
   */
  async registerCertificate(bundle: CertificateBundle): Promise<'registered' | 'unverified'> {
    const authorityKey = this.accountAuthorityKeys.get(
      `${bundle.certificate.account_id} ${bundle.certificate.account_epoch}`,
    );
    if (!authorityKey) return 'unverified'; // root-of-trust authority key unknown
    const verified = await verifyDeviceCertificate(bundle, authorityKey, {
      networkId: this.networkId,
      nowMs: this.now(),
    });
    if (!verified.ok) return 'unverified';
    this.certs.set(bundle.certificate.device_key_id, bundle);
    this.certKeys.set(
      bundle.certificate.device_key_id,
      await importPublicKeyCose(bundle.certificate.public_key_cose),
    );
    // Durably store the cert + its authority proof + index its CID so it is fetchable
    // (GET /records) and can join a §29.8 export closure even when registered out-of-band.
    const certCid = await cidFor('record', bundle.body);
    this.deviceCertCids.set(bundle.certificate.device_key_id, certCid);
    await this.storeIdentityClosure(certCid, bundle.body, bundle.proof);
    return 'registered';
  }

  /** The registered device certificate's record CID for a device key id (export closure). */
  deviceCertCid(deviceKeyId: string): string | undefined {
    return this.deviceCertCids.get(deviceKeyId);
  }

  /**
   * Durably store an identity record's body + its authority proof, and index the
   * record→proof edge, so the §29.8 export closure carries the full, re-validatable
   * identity material (not just the bare record) regardless of registration path.
   */
  private async storeIdentityClosure(
    recordCid: string,
    body: Uint8Array,
    proof: DetachedProofV2,
  ): Promise<void> {
    await this.store.storeObject(recordCid, 'record', body);
    const proofBytes = encodeWithSchema(detachedProofV2Schema, proof);
    const proofCid = await cidFor('proof', proofBytes);
    await this.store.storeObject(proofCid, 'proof', proofBytes);
    await this.store.indexRecordEdge(recordCid, proofCid, 'proof');
  }

  /** Register a room capability; returns its CID (the resolver + want key). */
  async registerCapability(bundle: CapabilityBundle): Promise<string> {
    const cid = await cidFor('record', bundle.body);
    this.capabilities.set(cid, bundle);
    // Durably store the capability + its room-authority proof so it is fetchable + can join
    // an export closure as re-validatable identity material.
    await this.storeIdentityClosure(cid, bundle.body, bundle.proof);
    return cid;
  }

  /**
   * Register an account-authority public key (it signs device certificates + account-scoped
   * revocations).  `signerKeyId` is the COSE id its proofs carry, indexed so a revocation's
   * authority proof resolves to this key + the account it governs.
   */
  registerAccountAuthorityKey(
    accountId: string,
    accountEpoch: number,
    key: CryptoKey,
    signerKeyId: string,
  ): void {
    this.accountAuthorityKeys.set(`${accountId} ${accountEpoch}`, key);
    this.authoritySigners.set(signerKeyId, { key, scope: 'account', scopeId: accountId });
  }

  /**
   * Register a room-authority public key (it signs capabilities, checkpoints, and
   * room-scoped revocations).  `signerKeyId` is indexed so a capability/room_policy
   * revocation's authority proof resolves to this key + the room it governs.
   */
  registerRoomAuthorityKey(
    roomId: string,
    policyEpoch: number,
    key: CryptoKey,
    signerKeyId: string,
  ): void {
    this.roomAuthorityKeys.set(`${roomId} ${policyEpoch}`, key);
    this.authoritySigners.set(signerKeyId, { key, scope: 'room', scopeId: roomId });
  }

  /**
   * Index a revocation (device / capability / account / room_policy / proof) ONLY after its
   * `authority_signature` proof verifies by a key with jurisdiction over the revoked target
   * (account authority for device/account/proof; room authority for capability/room_policy).
   * Without this gate a CSRF-exempt pack could index an arbitrary revocation and deny
   * service to any device/account/capability (§27 DoS) — `RevocationIndex` is trusted by
   * step 11 of the chain with no downstream re-check.  Returns whether it was indexed.
   */
  async registerRevocation(
    revocation: RevocationRecordV2,
    body: Uint8Array,
    proof: DetachedProofV2,
  ): Promise<'registered' | 'unverified'> {
    const result = await verifyRevocationAuthority({
      revocation,
      body,
      proof,
      resolveAuthority: (id) => this.authoritySigners.get(id),
      networkId: this.networkId,
    });
    if (!result.ok) return 'unverified';
    this.revocations.index(revocation);
    return 'registered';
  }

  /**
   * Authorize a §29.8 bundle export against the registered identity state (the export
   * gate): the device-signed, freshness-windowed `export_request` must cite a non-revoked
   * `may_export_bundle` capability for the room, authority-signed and unexpired, and be
   * signed by that capability's subject device.  Returns the authorization verdict; the
   * route produces the bundle only on `ok`.
   */
  authorizeExport(
    request: ExportRequestV2,
    body: Uint8Array,
    proof: DetachedProofV2,
  ): Promise<ExportAuthorizationResult> {
    return verifyExportAuthorization({
      request,
      body,
      proof,
      deps: {
        resolveCapability: (c) => this.capabilities.get(c),
        resolveRoomAuthorityKey: (r, e) => this.roomAuthorityKeys.get(`${r} ${e}`),
        resolveDevicePublicKey: (d) => this.certKeys.get(d),
        revocations: this.revocations,
      },
      ctx: { networkId: this.networkId, nowMs: this.now() },
    });
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

    // The device fork is decided ATOMICALLY at claim time, NOT by a read-then-write: a
    // racy `getDeviceClaimant` then `setDeviceClaimant` would let two concurrent records for
    // one (key, seq) both read "unclaimed" and both accept.  So first compute the verdict
    // IGNORING fork; only a would-accept record claims the sequence, and the claim's winner
    // decides accept-vs-fork.
    const provisional = ingestRecord({ alreadyHave, situation: { validation } });

    let outcome = provisional;
    let roomSeq: number | undefined;
    let forkClaimant: string | undefined;
    if (provisional.appendToRoomLog) {
      const claimant = await this.store.claimDeviceSeq(
        input.authorDeviceKeyId,
        input.deviceSeq,
        input.recordCid,
      );
      if (claimant === input.recordCid) {
        // We hold the (key, seq) claim → append to the canonical log (idempotent).
        roomSeq = await this.store.appendAcceptance(input.roomId, input.recordCid);
      } else {
        // A different record already claimed this (key, seq) → THIS record is a device fork.
        forkClaimant = claimant;
        outcome = ingestRecord({
          alreadyHave,
          situation: { validation, deviceForkDetected: true },
        });
      }
    } else if (alreadyHave) {
      roomSeq = await this.store.roomSeqOf(input.roomId, input.recordCid);
    }

    if (outcome.gossipForkEvidence && forkClaimant !== undefined) {
      await this.store.appendForkEvidence({
        authorDeviceKeyId: input.authorDeviceKeyId,
        deviceSeq: input.deviceSeq,
        existingCid: forkClaimant,
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
  /**
   * Run the §27.2 malicious-dependency-graph guard (WS-R.14.1b) over a DECLARED
   * dependency DAG under THIS server's §27.1 caps profile, BEFORE any closure
   * expansion.  A hostile graph (cycle / fan-out / depth / duplicate deps) is
   * rejected cheaply so it can never become a CPU/memory amplification vector.  The
   * server import path (`ingestPackFrames`) calls this over the pack table's
   * declared deps; `commitBatch` calls it over the batch's `requires`.
   */
  checkImportGraph(nodes: readonly GraphGuardNode[]): GraphGuardResult {
    return checkDependencyGraph(nodes, {
      audience: 'restricted',
      limits: graphLimitsFromCaps(this.caps),
    });
  }

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
    const guard = this.checkImportGraph(nodes);
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

    // §27.1 import CPU-time guard (WS-R.14.1a): a batch that runs past the cap stops
    // processing and rejects the remainder — a slow-import flood cannot pin a worker.
    const startMs = this.now();
    const overCpuBudget = (): boolean =>
      !checkCap(this.now() - startMs, 'maxCpuTimeMsPerImportBatch', this.caps).ok;

    // Satisfiable records, parents before children: the full stage-1+3 commit.  A record
    // is "accepted" for prerequisite purposes only once it reaches the room log (a
    // `roomSeq`); seed with the externally-accepted set.
    const acceptedInBatch = new Set<string>(acceptedExternally);
    for (const cid of resolution.order) {
      const input = byCid.get(cid);
      if (!input) continue;
      if (overCpuBudget()) {
        statuses.push({ cid, cid_kind: 'record', status: 'rejected_resource_limit' });
        continue;
      }
      // A required predecessor present in THIS batch must have actually been ACCEPTED, not
      // merely ordered ahead: if an in-pack prerequisite was rejected/quarantined upstream,
      // this dependent must quarantine too (and want it) rather than append to the canonical
      // room log with an unaccepted prerequisite (§24.4).
      const unmet = (input.requires ?? []).filter((req) => !acceptedInBatch.has(req));
      if (unmet.length > 0) {
        statuses.push({
          cid,
          cid_kind: 'record',
          status: 'quarantined_missing_dependency',
          missing_cids: unmet,
        });
        for (const dep of unmet) addWant(dep);
        continue;
      }
      const res = await this.commitRecord(input);
      statuses.push(res.status);
      for (const want of res.wants) addWant(want.cid);
      if (res.roomSeq !== undefined) acceptedInBatch.add(cid);
    }

    // Records with absent dependencies: durably store (stage 1), quarantine, want —
    // bounded by the §27.1 quarantine-byte cap so a missing-dep flood cannot fill the
    // store (and by the same CPU-time guard).
    let quarantineBytes = 0;
    for (const [cid, missing] of resolution.quarantined) {
      const input = byCid.get(cid);
      if (!input) continue;
      // Bound the per-object missing-dependency fan-out (§27.1): a small pack must not
      // produce an unbounded quarantine status / `wants` response via a transitive
      // dependency explosion.  Past the cap the object is rejected, nothing stored.
      if (missing.length > this.caps.maxMissingDepsPerObject) {
        statuses.push({ cid, cid_kind: 'record', status: 'rejected_resource_limit' });
        continue;
      }
      quarantineBytes += input.body.length;
      if (overCpuBudget() || !checkCap(quarantineBytes, 'maxQuarantineBytes', this.caps).ok) {
        statuses.push({ cid, cid_kind: 'record', status: 'rejected_resource_limit' });
        continue; // never store past the quarantine cap
      }
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

  // --- WS-R.12.4: the §16.2/§17.2/§17.3 sync frontier + the §29.1 pulse -----------

  // The server's fixed advertised sync capabilities (it is a public HTTPS relay).
  private static readonly SUPPORTED_SUITES: readonly CryptoSuiteId[] = ['ES256'];
  private static readonly SUPPORTED_COMPRESSION = ['none', 'gzip', 'deflate'] as const;
  private static readonly SUPPORTED_PACK_VERSIONS = [2] as const;

  /**
   * The §17.2 checkpoint frontier: one entry per room that has accepted records,
   * keyed by the privacy-scoped `room_id_hash` and reporting the room log's current
   * size (its §22 leaf count).  No `latest_checkpoint_cid` is emitted until
   * checkpoint issuance lands — the honest "how far along" signal is the tree size,
   * which already lets a peer detect it is behind on a room (§17.2).
   */
  async checkpointFrontier(): Promise<CheckpointFrontierV2[]> {
    const rooms = await this.store.listRooms();
    const frontier: CheckpointFrontierV2[] = [];
    for (const roomId of rooms) {
      frontier.push({
        room_id_hash: await roomIdHash(this.networkId, roomId),
        latest_tree_size: await this.store.roomSize(roomId),
      });
    }
    return frontier;
  }

  /** The §17.3 revocation frontier: the highest global revocation epoch the server holds. */
  revocationFrontier(): RevocationFrontierV2[] {
    return [{ scope: 'global', revocation_epoch: this.revocations.knownEpoch }];
  }

  /**
   * Assemble the server's own pulse (frontiers + capabilities), fail-closed-validated.
   * The session nonce is a fresh random value per call (the pulse is a transient,
   * un-hashed wire message; §16.2).
   */
  async serverPulse(): Promise<SyncPulseV2> {
    const sessionNonce = new Uint8Array(16);
    globalThis.crypto.getRandomValues(sessionNonce);
    return buildPulse({
      nodeId: `lcap-server:${this.networkId}`,
      sessionNonce,
      transportProfile: 'https',
      privacyMode: 'public',
      budgets: DEFAULT_BUDGET,
      supportedSuites: LcapIngestServer.SUPPORTED_SUITES,
      supportedCompression: LcapIngestServer.SUPPORTED_COMPRESSION,
      supportedPackVersions: LcapIngestServer.SUPPORTED_PACK_VERSIONS,
      checkpointFrontier: await this.checkpointFrontier(),
      revocationFrontier: this.revocationFrontier(),
    });
  }

  /**
   * The §29.1 pulse response: the server's pulse (frontiers) plus an optional inline
   * `critical_pack` (the C0 one-round-trip case — the route repacks the client's
   * `critical_want` objects the server holds).  A client that still lacks something
   * after the frontiers fetches it via the GET routes.
   */
  async pulseResponse(criticalPack?: Uint8Array): Promise<PulseResponseV2> {
    return buildPulseResponse({
      pulse: await this.serverPulse(),
      ...(criticalPack !== undefined ? { criticalPack } : {}),
    });
  }

  // --- WS-R.12.4: the §29.7 room checkpoint / inclusion / consistency reads --------

  // The §19.1 room-log tree algorithm (RFC 9162 SHA-256, the protocol default).
  private static readonly TREE_ALGORITHM: TreeAlgorithm = 'RFC9162_SHA256';

  /**
   * Reconstruct the room's §19.1 Merkle log from the store's canonical acceptance
   * order.  The log is rebuilt per request from the leaf CIDs (O(n) leaf hashes) —
   * persisting the tree is a later optimization (RoomLog's documented production
   * binding); the result is identical either way.
   */
  private async buildRoomLog(roomId: string): Promise<RoomLog> {
    const log = new RoomLog(LcapIngestServer.TREE_ALGORITHM, this.networkId);
    for (const cid of await this.store.roomLog(roomId)) await log.append(cid);
    return log;
  }

  /**
   * The §29.7 room tree head: the current tree size + Merkle root.  This is the
   * UNSIGNED head (size 0 → the RFC 9162 empty-tree hash); the authority-signed
   * `CheckpointRecordV2` attesting a witnessed root is checkpoint issuance, a later
   * card.  Inclusion/consistency proofs verify against this root regardless.
   */
  async roomTreeHead(
    roomId: string,
  ): Promise<{ treeSize: number; rootHash: Uint8Array; algorithm: TreeAlgorithm }> {
    const log = await this.buildRoomLog(roomId);
    return {
      treeSize: log.size,
      rootHash: await log.rootAt(),
      algorithm: LcapIngestServer.TREE_ALGORITHM,
    };
  }

  /** The §29.7 inclusion proof for `recordCid` in `roomId`, or `undefined` if absent. */
  async roomInclusionProof(
    roomId: string,
    recordCid: string,
  ): Promise<
    | { treeSize: number; leafIndex: number; auditPath: Uint8Array[]; algorithm: TreeAlgorithm }
    | undefined
  > {
    const log = await this.buildRoomLog(roomId);
    const leafIndex = log.seqOf(recordCid);
    if (leafIndex === undefined) return undefined;
    return {
      treeSize: log.size,
      leafIndex,
      auditPath: await log.inclusionProof(leafIndex),
      algorithm: LcapIngestServer.TREE_ALGORITHM,
    };
  }

  /**
   * The §29.7 consistency proof that the `second`-size prefix extends the `first`-
   * size prefix (RFC 9162 §2.1.4).  `'out_of_range'` when the sizes are not
   * `0 ≤ first ≤ second ≤ tree_size` integers (a non-retriable 400).
   */
  async roomConsistencyProof(
    roomId: string,
    first: number,
    second: number,
  ): Promise<
    | { firstSize: number; secondSize: number; proof: Uint8Array[]; algorithm: TreeAlgorithm }
    | 'out_of_range'
  > {
    const log = await this.buildRoomLog(roomId);
    if (
      !Number.isInteger(first) ||
      !Number.isInteger(second) ||
      first < 0 ||
      second < first ||
      second > log.size
    ) {
      return 'out_of_range';
    }
    return {
      firstSize: first,
      secondSize: second,
      proof: await log.consistencyProof(first, second),
      algorithm: LcapIngestServer.TREE_ALGORITHM,
    };
  }
}
