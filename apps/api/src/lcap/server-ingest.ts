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
  buildCheckpoint,
  buildPulse,
  buildPulseResponse,
  type CapabilityBundle,
  type CertificateBundle,
  type CheckpointBundle,
  type CheckpointFrontierV2,
  type ConsensusInput,
  type CryptoSuiteId,
  cappedBodyBlockCids,
  checkCap,
  checkDependencyGraph,
  cidFor,
  DEFAULT_BUDGET,
  type DetachedProofV2,
  decodeAndRouteRecord,
  decodeProof,
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
  isPublicControlRecord,
  type ObjectStatusV2,
  type PulseResponseV2,
  parseCid,
  type ReceiptRecordV2,
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
  signCheckpoint,
  signReceipt,
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
  /**
   * The cited capability's record CID, so the server can resolve its aggregate quotas and
   * debit the §18.3 step 9 budget on accept.  Absent only on the injected-validation apply
   * hook (no registered capability → no aggregate-quota enforcement on that test path).
   */
  readonly capabilityCid?: string;
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
  // Room-authority SIGNING keys (the private counterpart of `roomAuthorityKeys`) for rooms this
  // node is authoritative over, so it can ISSUE signed `room_checkpoint` records (WS-R.9.2b).  In
  // production these come from the SecretBox-encrypted `*_AUTHORITY_*` key group; a room with no
  // signer here is simply not checkpointed by this node (the §29.7 read falls back to the head).
  private readonly roomAuthoritySigners = new Map<
    string,
    { privateKey: CryptoKey; signerKeyId: string; policyEpoch: number }
  >();
  // The latest signed checkpoint this node issued per room (the chain head + the §29.7 served
  // value + the §17.2 frontier `latest_checkpoint_cid`).  The bytes also live in the CAS, so the
  // checkpoint + its proof are fetchable by CID like any other object.
  private readonly latestCheckpoints = new Map<string, { bundle: CheckpointBundle; cid: string }>();
  // The node's receipt-signing key (the §20.4 issuer).  When configured, the server emits signed
  // `receipt` records for ingestion outcomes (WS-R.10.2); without it, no receipt is emitted (a
  // receipt is only an availability HINT, never content trust, so its absence is always safe).
  private receiptIssuer?: { privateKey: CryptoKey; signerKeyId: string; nodeId: string };

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

  /**
   * Whether a contribution/identity record's BYTES are eligible for the PUBLIC serve surface.
   * Mirrors the client responder (apps/web/src/lcap/exchange.ts `collectShareableCids`): ONLY a
   * record carrying a NON-PUBLIC `visibility_scope` is withheld; identity records (device
   * certificate / revocation / account authority) carry no visibility_scope and are public
   * validation material.
   *
   * A `room_checkpoint` is the one CONTROL record that reaches this gate: `issueCheckpoint` stores
   * it as a `record`, and `checkpointFrontier` advertises its CID (`latest_checkpoint_cid`), so a
   * peer fetches it (and its detached proof) over the public §29 surface.  `decodeAndRouteRecord`
   * rejects it by design (it is not a routed contribution/identity record), so without special
   * handling the gate would withhold a CID it advertises — `isPublicControlRecord` recognizes the
   * well-formed checkpoint as public transparency material (PUB-API-CHECKPOINT-1).  Any OTHER
   * undecodable / unrouted record is never served (fail-closed).
   */
  private static recordIsPublic(bytes: Uint8Array): boolean {
    let record: ReturnType<typeof decodeAndRouteRecord>;
    try {
      record = decodeAndRouteRecord(bytes);
    } catch {
      return isPublicControlRecord(bytes);
    }
    return !('visibility_scope' in record) || record.visibility_scope === 'public';
  }

  /**
   * Whether `blockCid` is a block reference of contribution `bytes`'s SIGNED body — the author's
   * attestation of which blocks it owns — re-derived via the SHARED `cappedBodyBlockCids` (the exact
   * client derivation), NOT the unauthenticated pack-table edge `recordsReferencing` indexes.  This
   * is the §29 serve gate's defence against PUB-API-BLOCK-OWNER-2: a valid public contribution that
   * names a PRIVATE block CID only in its pack-table `deps` must NOT make that block public.  The
   * fan-out scan is §27.1-bounded (an accepted body is already within the cap; the bound is
   * defence-in-depth), never O(n) over `source_snapshot_cids`.
   */
  private recordOwnsBlockBySignedBody(bytes: Uint8Array, blockCid: string): boolean {
    let record: ReturnType<typeof decodeAndRouteRecord>;
    try {
      record = decodeAndRouteRecord(bytes);
    } catch {
      return false;
    }
    if (record.kind !== 'contribution_event') return false;
    return cappedBodyBlockCids(record, this.caps.maxFanOut).cids.includes(blockCid);
  }

  /**
   * Whether `cid` may be served over the PUBLIC §29 read/exchange surface (the GET content routes +
   * the pulse/exchange repack).  This is the SERVER counterpart of the client's PUBLIC-ONLY
   * responder (`collectShareableCids`) and closes PUB-API-CORE-1: a non-public (`room_only`) record,
   * its proofs, and its body/media BLOCKS are NEVER served by CID over the unauthenticated surface,
   * so a caller that learns an in_room CID (e.g. a removed member) cannot exfiltrate the plaintext.
   *
   *   • record → public iff its own `visibility_scope` is public (or it is identity material);
   *   • proof  → public iff the record it attests is public;
   *   • block  → public iff SOME record that references it (body / thumbnail / image / manifest /
   *              source-snapshot edge) is public — resolved via the reverse closure edge;
   *   • chunk  → NEVER public here.  A `chunk` carries no visibility and the server cannot resolve
   *              it to its owning record (a block CID addresses raw bytes; the descriptor that lists
   *              `chunk_cids` is not stored under a server-decodable key), so — exactly like the
   *              client responder, which also never serves chunks — a chunk is withheld over the
   *              public surface (fail-closed).  Authorized chunked-media serving is the separate
   *              §29.4 "if authorized" path (a tracked enhancement), never this public one.
   *
   * The capability-authorized §29.8 room export is a SEPARATE path and is intentionally NOT gated
   * here (an authorized export carries the room's full in_room closure by design).
   */
  async isPublicServable(cid: string): Promise<boolean> {
    const obj = await this.store.getObject(cid);
    if (!obj) return false;
    switch (obj.kind) {
      case 'record':
        return LcapIngestServer.recordIsPublic(obj.bytes);
      case 'proof': {
        let recordCid: string;
        try {
          recordCid = decodeProof(obj.bytes).record_cid;
        } catch {
          return false;
        }
        const rec = await this.store.getObject(recordCid);
        return rec?.kind === 'record' && LcapIngestServer.recordIsPublic(rec.bytes);
      }
      case 'block': {
        for (const recordCid of await this.store.recordsReferencing(cid, 'block')) {
          // A block carries no visibility of its own — it is authorized by a record that references
          // it.  THREE conditions must ALL hold; any one alone is exploitable:
          //   1. ACCEPTED — `ingestPackFrames` records the block→record edge BEFORE `commitBatch`
          //      proves the contribution, so an INVALID/REJECTED public record must not authorize a
          //      block (PUB-API-BLOCK-OWNER-1); the acceptance log records only validate→guard→commit.
          //   2. PUBLIC — the owner's own `visibility_scope` (a non-public owner never serves a block).
          //   3. SIGNED-BODY OWNERSHIP — the block CID must be a ref of the owner's SIGNED body, NOT
          //      the UNAUTHENTICATED pack-table edge `recordsReferencing` indexes.  Otherwise an
          //      attacker uploads a VALID public contribution that names a known PRIVATE block CID
          //      ONLY in the pack-table `deps`, and the table edge would disclose that block.  The
          //      signed body is the author's attestation of which blocks the contribution owns
          //      (PUB-API-BLOCK-OWNER-2) — re-derived via the SHARED `cappedBodyBlockCids`.
          if (!(await this.store.isAccepted(recordCid))) continue;
          const rec = await this.store.getObject(recordCid);
          if (rec?.kind !== 'record' || !LcapIngestServer.recordIsPublic(rec.bytes)) continue;
          if (this.recordOwnsBlockBySignedBody(rec.bytes, cid)) return true;
        }
        return false;
      }
      case 'chunk':
        return false;
    }
  }

  /** The PUBLIC-servable subset of `cids`, preserving order — the want filter the pulse/exchange
   *  responder applies BEFORE repack so a non-public want is never assembled into a served pack. */
  async filterPublicServable(cids: readonly string[]): Promise<string[]> {
    const out: string[] = [];
    for (const cid of cids) if (await this.isPublicServable(cid)) out.push(cid);
    return out;
  }

  /**
   * The canonical `room_id_hash` for a record's bytes — `roomIdHash(networkId, roomId)` over the
   * record's signed room id (`home_room_id` / `room_id`).  The repack stamps it onto a served
   * record (the room is NOT in the body it could re-derive from), so the receiver lands the record
   * with its real room key (matching the room frontier + the client "Sync this room" scope).
   * Returns `undefined` for a record kind that carries no room (certificate / revocation / fork).
   */
  async roomIdHashForRecord(bytes: Uint8Array): Promise<Uint8Array | undefined> {
    let record: ReturnType<typeof decodeAndRouteRecord>;
    try {
      record = decodeAndRouteRecord(bytes);
    } catch {
      return undefined;
    }
    const roomId =
      record.kind === 'contribution_event'
        ? record.home_room_id
        : record.kind === 'room_capability'
          ? record.room_id
          : undefined;
    return roomId === undefined ? undefined : roomIdHash(this.networkId, roomId);
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

  /** Append `cid` to a room's acceptance log (idempotent), marking the contribution ACCEPTED.  The
   *  public-block serve gate (`isPublicServable`) authorizes a block only via an ACCEPTED owner
   *  (PUB-API-BLOCK-OWNER-1); this passthrough lets a direct-store setup mark that acceptance without
   *  driving the full validate→guard→commit path. */
  appendAcceptance(roomId: string, cid: string): Promise<number> {
    return this.store.appendAcceptance(roomId, cid);
  }

  /**
   * Index a contribution's SIGNED-BODY-declared media block references (its `block` edges:
   * `body_block_cid` / `attachment_manifest_cid` / `source_snapshot_cids` / `target_source_snapshot_cid`)
   * under the §27.1 reference cap (`maxFanOut`).  These refs are NOT part of the §27.2-guarded table
   * DAG, so without a bound a record naming thousands of `source_snapshot_cids` would drive an
   * unbounded (awaited) index-write loop here BEFORE signature validation — a §27 DoS,
   * amplified on the durable store.  The DECLARED count is bounded FIRST (before any parse),
   * so an over-cap record costs O(1): it indexes NOTHING and returns `false` (the caller
   * rejects it `rejected_resource_limit`).  Within the cap, each block-kind ref is indexed
   * (the store de-duplicates, so a block named in both the body and the table is one edge).
   *
   * The `target_source_snapshot_cid` is a SEPARATE block edge (NOT part of the fan-out-capped
   * body/attachment/source-snapshot set), so — EXACTLY as the shared `cappedBodyBlockCids`
   * includes it unconditionally in a contribution's owned-block set — it is indexed here without
   * competing for a cap slot.  Otherwise a block referenced ONLY via the signed-body target
   * snapshot would never appear in the reverse `recordsReferencing` / forward `recordEdges`
   * index, so `isPublicServable` (the §29 serve gate) and `exportRoomClosureCids` (the §29.8
   * room export) would silently omit a legitimately PUBLIC block whose accepted owner attests
   * ownership in its SIGNED body (#1 — the serve gate's signed-body check already accepts it).
   */
  async indexBodyBlockEdges(
    recordCid: string,
    refs: {
      readonly bodyBlockCid?: string;
      readonly attachmentManifestCid?: string;
      readonly sourceSnapshotCids?: readonly string[];
      readonly targetSourceSnapshotCid?: string;
    },
  ): Promise<boolean> {
    const snapshots = refs.sourceSnapshotCids ?? [];
    const singles = (refs.bodyBlockCid ? 1 : 0) + (refs.attachmentManifestCid ? 1 : 0);
    // Bound the DECLARED count via `.length` FIRST — before materializing or spreading the
    // (possibly huge) `source_snapshot_cids` array — so an over-cap record costs O(1) and a
    // large spread can never even be attempted.  The target snapshot is a separate edge (a single
    // bounded ref) and is intentionally NOT part of this fan-out count (mirrors `cappedBodyBlockCids`).
    if (singles + snapshots.length > this.caps.maxFanOut) return false;
    const candidates: string[] = [];
    if (refs.bodyBlockCid !== undefined) candidates.push(refs.bodyBlockCid);
    if (refs.attachmentManifestCid !== undefined) candidates.push(refs.attachmentManifestCid);
    for (const snapshot of snapshots) candidates.push(snapshot); // ≤ maxFanOut here
    // The target snapshot is a SEPARATE block edge — included unconditionally (it must not lose a
    // cap slot), matching `cappedBodyBlockCids`, so the block it points at is reverse-indexed and
    // therefore servable/exportable when its accepted public owner attests it in the signed body.
    if (refs.targetSourceSnapshotCid !== undefined) candidates.push(refs.targetSourceSnapshotCid);
    for (const ref of candidates) {
      try {
        if (parseCid(ref).kind === 'block')
          await this.store.indexRecordEdge(recordCid, ref, 'block');
      } catch {
        // a malformed body CID is ignored (the record will quarantine/reject on validate)
      }
    }
    return true;
  }

  /**
   * The §11.4 "media bytes" a contribution brings in: the summed ACTUAL stored size of ALL the
   * blocks it references (its `block` edges — the body/media/attachment closure — present in the
   * CAS at accept).  The figure is the server's own CID-verified byte length, never the author's
   * declaration.  The server does not parse per-block roles, so every referenced block counts
   * (the conservative reading of §11.4 "referenced block sizes"; per-role weighting needs the
   * attachment-manifest descriptors and is a tracked refinement).  A referenced block not yet
   * held contributes 0 — cross-pack lazy media is bounded by the §27.1 block caps and the
   * `max_offline_events` count, and is charged when it arrives in the contribution's own pack.
   */
  private async referencedMediaBytes(recordCid: string): Promise<number> {
    let mediaBytes = 0;
    for (const blockCid of await this.store.recordEdges(recordCid, 'block')) {
      const obj = await this.store.getObject(blockCid);
      if (obj) mediaBytes += obj.bytes.length;
    }
    return mediaBytes;
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
   * Register the room-authority SIGNING key for a room this node is authoritative over, so it can
   * ISSUE signed `room_checkpoint` records (WS-R.9.2b).  This is the private counterpart of
   * `registerRoomAuthorityKey`; a node that issues checkpoints registers BOTH (the public key
   * verifies its own + peers' checkpoints, the private key signs new ones).
   */
  registerRoomAuthoritySigner(
    roomId: string,
    policyEpoch: number,
    privateKey: CryptoKey,
    signerKeyId: string,
  ): void {
    this.roomAuthoritySigners.set(roomId, { privateKey, signerKeyId, policyEpoch });
  }

  /**
   * Issue (build + room-authority-sign + durably store) a `room_checkpoint` over the room's
   * current canonical acceptance log (WS-R.9.2b / §24.1 checkpoint trigger).  IDEMPOTENT by tree
   * size: a re-issue at an unchanged `tree_size` returns the existing checkpoint (no churn,
   * stable chain).  Successive checkpoints chain via `previous_checkpoint_cid`.  Returns the
   * signed bundle, or `undefined` when this node holds no signer for the room or the log is empty
   * (an empty room has nothing to attest).  The checkpoint body + its proof land in the CAS, so
   * both are fetchable by CID through the §29 GET routes.
   */
  async issueCheckpoint(roomId: string): Promise<CheckpointBundle | undefined> {
    const signer = this.roomAuthoritySigners.get(roomId);
    if (!signer) return undefined;
    const log = await this.buildRoomLog(roomId);
    if (log.size === 0) return undefined; // nothing accepted yet — no checkpoint to attest
    const prev = this.latestCheckpoints.get(roomId);
    if (prev && prev.bundle.checkpoint.tree_size === log.size) return prev.bundle; // idempotent

    const checkpoint = await buildCheckpoint(log, {
      roomId,
      treeSize: log.size,
      policyEpoch: signer.policyEpoch,
      revocationEpoch: this.revocations.knownEpoch,
      issuedAtMs: this.now(),
      signerAuthorityId: signer.signerKeyId,
      ...(prev ? { previousCheckpointCid: prev.cid } : {}),
    });
    const bundle = await signCheckpoint({
      authorityPrivateKey: signer.privateKey,
      authoritySignerKeyId: signer.signerKeyId,
      checkpoint,
      networkId: this.networkId,
    });
    // Durably store the checkpoint record + its proof so both are fetchable by CID (§29).
    const cid = await cidFor('record', bundle.body);
    await this.store.storeObject(cid, 'record', bundle.body);
    const proofBytes = encodeWithSchema(detachedProofV2Schema, bundle.proof);
    await this.store.storeObject(await cidFor('proof', proofBytes), 'proof', proofBytes);
    this.latestCheckpoints.set(roomId, { bundle, cid });
    return bundle;
  }

  /**
   * The §24.1 checkpoint maintenance tick: issue a fresh checkpoint for every room whose log has
   * grown since its last one (idempotent for unchanged rooms).  Returns the rooms checkpointed.
   */
  async issueAllCheckpoints(): Promise<readonly string[]> {
    const issued: string[] = [];
    for (const roomId of await this.store.listRooms()) {
      const before = this.latestCheckpoints.get(roomId)?.cid;
      const bundle = await this.issueCheckpoint(roomId);
      if (bundle && this.latestCheckpoints.get(roomId)?.cid !== before) issued.push(roomId);
    }
    return issued;
  }

  /** The latest signed checkpoint this node issued for a room (the §29.7 served value), or none. */
  latestCheckpoint(roomId: string): { bundle: CheckpointBundle; cid: string } | undefined {
    return this.latestCheckpoints.get(roomId);
  }

  /**
   * The §29.7 wire form of a room's latest signed checkpoint: the CID-addressed record body + its
   * detached authority proof (both also fetchable individually via the §29 GET routes).  A peer
   * decodes + verifies the proof against the room authority key, then checks `merkle_root` against
   * its own log.  `undefined` when this node has issued no checkpoint for the room.
   */
  async latestCheckpointWire(roomId: string): Promise<
    | {
        cid: string;
        recordBody: Uint8Array;
        proofCid: string;
        proofBody: Uint8Array;
      }
    | undefined
  > {
    const latest = this.latestCheckpoints.get(roomId);
    if (!latest) return undefined;
    const proofBody = encodeWithSchema(detachedProofV2Schema, latest.bundle.proof);
    return {
      cid: latest.cid,
      recordBody: latest.bundle.body,
      proofCid: await cidFor('proof', proofBody),
      proofBody,
    };
  }

  /**
   * Configure this node's receipt-signing identity (the §20.4 issuer), so ingestion outcomes
   * are attested by signed `receipt` records (WS-R.10.2).  In production the key comes from the
   * SecretBox-encrypted node-key group; `nodeId` defaults to this server's pulse node id.
   */
  configureReceiptIssuer(privateKey: CryptoKey, signerKeyId: string, nodeId?: string): void {
    this.receiptIssuer = {
      privateKey,
      signerKeyId,
      nodeId: nodeId ?? `lcap-server:${this.networkId}`,
    };
  }

  /** The §20.4 receipt type a per-object status belongs to (or none — receipts attest handling). */
  private static receiptTypeForStatus(
    status: ObjectStatusV2['status'],
  ): ReceiptRecordV2['receipt_type'] | undefined {
    if (status === 'accepted') return 'accepted';
    if (
      status === 'stored_unverified' ||
      status === 'stored_pending' ||
      status === 'already_have'
    ) {
      return 'stored';
    }
    if (status.startsWith('quarantined')) return 'quarantined';
    if (status.startsWith('rejected') || status === 'conflict_device_fork') return 'rejected';
    return undefined;
  }

  /**
   * Issue signed `receipt` records over a batch's per-object statuses (WS-R.10.2 / §24.5),
   * grouped by receipt type (one `accepted` / `stored` / `quarantined` / `rejected` receipt over
   * its members, each carrying the per-object `status_detail`).  Each receipt's record + detached
   * proof are durably stored (CID-addressed, fetchable via §29), and every covered status is
   * stamped with its `receipt_cid`.  A receipt is an availability HINT + audit evidence, never
   * content trust — a forged issuer is just an untrusted hint.  No-op (statuses unchanged, no
   * receipts) when no issuer is configured.
   */
  async issueReceipts(statuses: readonly ObjectStatusV2[]): Promise<{
    statuses: ObjectStatusV2[];
    receipts: {
      cid: string;
      recordBody: Uint8Array;
      proofCid: string;
      proofBody: Uint8Array;
      record: ReceiptRecordV2;
    }[];
  }> {
    const issuer = this.receiptIssuer;
    if (!issuer) return { statuses: statuses.map((s) => ({ ...s })), receipts: [] };

    // Group the statuses by the receipt type their outcome maps to (preserving order).
    const byType = new Map<ReceiptRecordV2['receipt_type'], ObjectStatusV2[]>();
    for (const s of statuses) {
      const receiptType = LcapIngestServer.receiptTypeForStatus(s.status);
      if (receiptType === undefined) continue;
      const group = byType.get(receiptType);
      if (group) group.push(s);
      else byType.set(receiptType, [s]);
    }

    const receiptCidByCid = new Map<string, string>();
    const receipts: {
      cid: string;
      recordBody: Uint8Array;
      proofCid: string;
      proofBody: Uint8Array;
      record: ReceiptRecordV2;
    }[] = [];
    for (const [receiptType, group] of byType) {
      const record: ReceiptRecordV2 = {
        record_version: 2,
        kind: 'receipt',
        receipt_type: receiptType,
        issuer_node_id: issuer.nodeId,
        subject_cids: group.map((s) => s.cid),
        issued_at_claim_ms: this.now(),
        // The per-object verdict (a mutable copy — `ObjectStatusV2` is readonly-typed; the
        // receipt schema's `status_detail` array is mutable).  Carries the FINE status (e.g.
        // which rejection reason), self-describing the receipt without the response statuses.
        status_detail: group.map((s) => ({
          cid: s.cid,
          cid_kind: s.cid_kind,
          status: s.status,
          ...(s.missing_cids !== undefined ? { missing_cids: [...s.missing_cids] } : {}),
          ...(s.detail_code !== undefined ? { detail_code: s.detail_code } : {}),
          ...(s.receipt_cid !== undefined ? { receipt_cid: s.receipt_cid } : {}),
        })),
      };
      const bundle = await signReceipt({
        issuerPrivateKey: issuer.privateKey,
        issuerSignerKeyId: issuer.signerKeyId,
        receipt: record,
        networkId: this.networkId,
      });
      const cid = await cidFor('record', bundle.body);
      await this.store.storeObject(cid, 'record', bundle.body);
      const proofBody = encodeWithSchema(detachedProofV2Schema, bundle.proof);
      const proofCid = await cidFor('proof', proofBody);
      await this.store.storeObject(proofCid, 'proof', proofBody);
      receipts.push({ cid, recordBody: bundle.body, proofCid, proofBody, record });
      for (const s of group) receiptCidByCid.set(s.cid, cid);
    }

    const stamped = statuses.map((s) => {
      const receiptCid = receiptCidByCid.get(s.cid);
      return receiptCid !== undefined ? { ...s, receipt_cid: receiptCid } : { ...s };
    });
    return { statuses: stamped, receipts };
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
        // We hold the (key, seq) claim.  Append to the canonical log AND enforce the
        // capability's aggregate quotas (§18.3 step 9) atomically as one accept: the budget
        // is debited iff the record is freshly accepted (idempotent by cid).  An over-budget
        // record is rejected `rejected_quota` and never appends.  The injected-validation
        // apply hook (no registered capability) falls back to a raw append (no aggregate quota).
        const capBundle =
          input.capabilityCid !== undefined
            ? this.capabilities.get(input.capabilityCid)
            : undefined;
        if (capBundle) {
          // The §18.3 step 9 `max_media_bytes` debit: the summed stored size of the media
          // blocks this contribution ships (its referenced blocks present at accept; §11.4
          // "media bytes").  Computed from the record's `block` edges + the actual CID-verified
          // byte length the server holds, so it is never the author's declared figure.
          const mediaBytes = await this.referencedMediaBytes(input.recordCid);
          const accepted = await this.store.acceptContribution(
            input.roomId,
            input.recordCid,
            input.body.length,
            mediaBytes,
            {
              capabilityId: capBundle.capability.capability_id,
              maxEvents: capBundle.capability.quotas.max_offline_events,
              maxTotalBytes: capBundle.capability.quotas.max_total_payload_bytes,
              maxMediaBytes: capBundle.capability.quotas.max_media_bytes,
            },
          );
          if (accepted.ok) {
            roomSeq = accepted.seq;
          } else {
            // Aggregate quota exhausted (events / total payload / media) — reject without
            // appending (the device-seq claim stands; the capability budget is NOT debited).
            // `rejected_quota` (§16.11).
            return {
              status: { cid: input.recordCid, cid_kind: 'record', status: 'rejected_quota' },
              wants: [],
              receiptType: 'rejected',
            };
          }
        } else {
          roomSeq = await this.store.appendAcceptance(input.roomId, input.recordCid);
        }
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

  /**
   * A §27.1 CPU-time budget for one pack import (`maxCpuTimeMsPerImportBatch`), returned as a
   * cheap `overBudget()` poll.  `commitBatch` already time-bounds the COMMIT phase; the pack
   * parse + store + edge-index phase (`ingestPackFrames`) uses this to bound ITSELF too, so a
   * large multi-object pack — whose total store/index writes are bounded by the §27.2 node cap
   * and the §27.1 byte caps but can still be O(10^5) on a durable store — cannot pin a worker.
   * The deadline is read from THIS server's caps + clock, mirroring `commitBatch`.
   */
  newImportBudget(): () => boolean {
    const startMs = this.now();
    return (): boolean =>
      !checkCap(this.now() - startMs, 'maxCpuTimeMsPerImportBatch', this.caps).ok;
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
   * size (its §22 leaf count) plus the `latest_checkpoint_cid` once this node has
   * issued a signed checkpoint for the room (WS-R.9.2b).  The tree size alone already
   * lets a peer detect it is behind; the checkpoint CID lets it fetch + verify the
   * signed head against the authority key.
   */
  async checkpointFrontier(): Promise<CheckpointFrontierV2[]> {
    const rooms = await this.store.listRooms();
    const frontier: CheckpointFrontierV2[] = [];
    for (const roomId of rooms) {
      const checkpointCid = this.latestCheckpoints.get(roomId)?.cid;
      frontier.push({
        room_id_hash: await roomIdHash(this.networkId, roomId),
        latest_tree_size: await this.store.roomSize(roomId),
        ...(checkpointCid !== undefined ? { latest_checkpoint_cid: checkpointCid } : {}),
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
   * `room_checkpoint` attesting a root is issued separately by `issueCheckpoint`
   * (served alongside this head when present, via `latestCheckpointWire`).
   * Inclusion/consistency proofs verify against this root regardless.
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
