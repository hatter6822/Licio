// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S — the client-side private-room ENGINE: the pure orchestration that
// composes the §14.2 wire-intake (`openOp`), the §10.4 device-blind resolution
// (`buildOpIntakeContext`), the §14.3 deterministic fold (`reduceRoom`), and the
// op author path (`sealOp`) into a single object a UI (or a transport) drives.
// It is transport- and storage-AGNOSTIC: durable bytes live behind a
// `PrivateRoomStorage` port (an in-memory adapter ships here; the apps/web
// IndexedDB adapter implements the same port), and a P2P transport simply calls
// `ingest(envelopes)` with blocks it fetched.  NOTHING is trusted on the way in:
// every envelope — even one re-read from local storage on load — is re-verified
// through `openOp` before it contributes to state (§8.3 verify-before-use).
//
// Genesis + in-batch ordering: a device added by an op opened earlier in the
// same batch must become resolvable for ops it later authors.  `ingest` runs a
// bounded FIXPOINT — open what the current state resolves, fold, rebuild the
// context, repeat until no new op opens — so a correctly-ordered causal set
// always converges regardless of delivery order; the unresolved remainder is
// quarantined with its typed reason and never rendered.

import {
  decryptAttachment,
  type EncryptedAttachment,
  openAttachmentManifest,
} from '../crypto/attachment.js';
import { canonical } from '../crypto/canonical.js';
import { PRIVATE_CID_CODEC, verifyPrivateCid } from '../crypto/cid.js';
import { deriveAuthorDeviceIdBlind } from '../crypto/device-blind.js';
import { fromBase64Url, sha256, toBase64Url } from '../crypto/runtime.js';
import { OP_REQUIRED_CAPABILITY } from '../reducer/capabilities.js';
import {
  type BootstrapDevice,
  buildOpIntakeContext,
  type HeldEpochKeys,
} from '../reducer/intake-context.js';
import { reduceRoom } from '../reducer/reduce.js';
import {
  openSnapshotBundle,
  type SealedSnapshotWire,
  type SnapshotBundle,
  sealSnapshotBundle,
} from '../reducer/snapshot-seal.js';
import { deserializeReducerState, serializeReducerState } from '../reducer/snapshot-state.js';
import { type RoomReducerState, roomStateCommitment } from '../reducer/state.js';
import { validateStructure } from '../reducer/validate.js';
import {
  type OpIntakeRejection,
  openOp,
  type SealOpParams,
  sealOp,
} from '../reducer/validate-op.js';
import type { PrivateEncryptedEnvelope } from '../schemas/envelope.js';
import { type PrivateRoomOp, privateRoomOpSchema } from '../schemas/ops.js';
import {
  buildBlockArchive,
  decodeBlockArchive,
  encodeBlockArchive,
  type PrivateArchiveKind,
} from '../sync/archive.js';
import {
  buildHeadAnnouncement,
  computeHeads,
  type HeadAnnouncement,
  missingParents,
  wantedHeads,
} from '../sync/head-sync.js';

/**
 * §27 DoS bound on the recoverable-failure retention pool.  `unknown_device` is returned
 * by `openOp` BEFORE the signature is verified (an unrecognised author-blind has no key to
 * verify against), so an UNAUTHENTICATED peer can stream envelopes with random blinds +
 * random signatures, each a fresh pool key — unbounded memory without a cap.  The pool is
 * bounded here (never disable-able); on overflow the OLDEST entries are evicted first (an
 * evicted legitimate pending op is simply re-fetched by the §15.7 sync walk).
 */
const MAX_PENDING_ENVELOPES = 4_096;

/** The durable boundary for a room's encrypted envelopes (keyed by op id). */
export interface PrivateRoomStorage {
  /** Persist an ACCEPTED envelope under its op id, LAST-WRITE-WINS: the engine
   *  passes the deterministically-chosen winner of a device fork (same op_id,
   *  different content), so a later write must replace an earlier one for that id. */
  putEnvelope(opId: string, envelope: PrivateEncryptedEnvelope): Promise<void>;
  /** Every stored envelope (re-verified on load — storage confers no trust). */
  listEnvelopes(): Promise<ReadonlyArray<{ opId: string; envelope: PrivateEncryptedEnvelope }>>;
  /** Drop envelopes pruned by a §14.5 compaction (idempotent — absent ids no-op). */
  deleteEnvelopes(opIds: readonly string[]): Promise<void>;
  /** §13.6 — persist a CID-addressed content-addressed block (an attachment manifest or
   *  media chunk; the encrypted BYTES, opaque to storage).  The engine writes a block
   *  only after verifying its CID, so storage need not re-verify. Idempotent. */
  putBlock(cid: string, bytes: Uint8Array): Promise<void>;
  /** A stored block's bytes, or `undefined` if absent.  The engine re-verifies the CID
   *  on read where trust matters (storage confers no trust). */
  getBlock(cid: string): Promise<Uint8Array | undefined>;
  /** Whether a block is stored (drives the §15.8 want-list without fetching bytes). */
  hasBlock(cid: string): Promise<boolean>;
}

/** An in-memory `PrivateRoomStorage` (local/dev + tests; apps/web uses IndexedDB). */
export class InMemoryPrivateRoomStorage implements PrivateRoomStorage {
  private readonly envelopes = new Map<string, PrivateEncryptedEnvelope>();
  private readonly blocks = new Map<string, Uint8Array>();

  putEnvelope(opId: string, envelope: PrivateEncryptedEnvelope): Promise<void> {
    this.envelopes.set(opId, envelope); // last-write-wins (the engine passes the fork winner)
    return Promise.resolve();
  }

  listEnvelopes(): Promise<ReadonlyArray<{ opId: string; envelope: PrivateEncryptedEnvelope }>> {
    return Promise.resolve([...this.envelopes].map(([opId, envelope]) => ({ opId, envelope })));
  }

  deleteEnvelopes(opIds: readonly string[]): Promise<void> {
    for (const id of opIds) this.envelopes.delete(id);
    return Promise.resolve();
  }

  putBlock(cid: string, bytes: Uint8Array): Promise<void> {
    this.blocks.set(cid, bytes);
    return Promise.resolve();
  }

  getBlock(cid: string): Promise<Uint8Array | undefined> {
    return Promise.resolve(this.blocks.get(cid));
  }

  hasBlock(cid: string): Promise<boolean> {
    return Promise.resolve(this.blocks.has(cid));
  }
}

/**
 * A persisted §14.5 compaction base for reload (WS-S.7 client persistence): the
 * SEALED snapshot body (the §14.5 in-band `snapshot.commit` references its CID).
 * The body carries the full reduced state PLUS the structural metadata a reloading
 * device needs (every covered op's lamport, the covered heads, the Lamport ceiling,
 * the per-device seq floor), so reload opens it under the epoch key and folds only
 * the post-snapshot envelopes.  Persisting the EXACT sealed bytes (not a re-seal)
 * keeps the committed `snapshot_body_cid` valid, so the same base also exports.
 */
export interface PersistedSnapshotBase {
  readonly sealedSnapshot: SealedSnapshotWire;
}

/** The opened base the constructor seeds from (the sealed body decrypted + parsed). */
interface OpenedSnapshotBase {
  readonly state: RoomReducerState;
  readonly coveredOps: ReadonlyArray<readonly [string, string]>;
  readonly coveredHeads: readonly string[];
  readonly maxLamport: string;
  readonly authorSeq: ReadonlyArray<readonly [string, number]>;
  readonly sealedSnapshot: SealedSnapshotWire;
}

/** A quarantined envelope + why it did not contribute to state: a §14.2 stage-1
 *  failure (`OpIntakeRejection`), or `duplicate_op_id` for the LOSING side of a
 *  device fork (two valid envelopes with the same `op_id` but different content —
 *  the engine keeps the deterministically-chosen one, never silently the first). */
export type IngestQuarantineReason = OpIntakeRejection | 'duplicate_op_id';
export interface QuarantinedEnvelope {
  readonly envelope: PrivateEncryptedEnvelope;
  readonly reason: IngestQuarantineReason;
}

/** The outcome of an `ingest` / `applyLocalOp` call. */
export interface IngestReport {
  /** Op ids newly accepted into state by this call. */
  readonly accepted: string[];
  /** Envelopes that did not open (unknown device / decrypt failed / …). */
  readonly quarantined: QuarantinedEnvelope[];
}

/** A §14.5 snapshot of the reduced state (the optimization that bounds replay +
 *  enables §25.6 compaction).  `bundle` is the full body (state + structural
 *  metadata) the caller seals + content-addresses; `stateRoot` is the verifiable
 *  §14.5 commitment; `coveredOps` (op id → lamport) + `coveredHeads` are the
 *  structurally-ACCEPTED prefix it summarizes (a crypto-opened-but-structurally-
 *  invalid op is NOT covered — it stays to resolve when its dependency arrives). */
export interface SnapshotResult {
  readonly bundle: SnapshotBundle;
  readonly stateRoot: string;
  readonly coveredOps: ReadonlyArray<readonly [string, string]>;
  readonly coveredHeads: string[];
}

export interface PrivateRoomEngineParams {
  readonly roomId: string;
  readonly roomIdCommitment: Uint8Array;
  readonly storage: PrivateRoomStorage;
  /** The epoch keys the local device holds (epoch → secret + content_wrap_key). */
  readonly epochs: ReadonlyMap<number, HeldEpochKeys>;
  /** The §14.2 genesis bootstrap: device verify keys known out of band — the
   *  creator's own device, or a joiner's verified-manifest member devices —
   *  needed to open the genesis (founder self-add) op before any device is in
   *  reduced state. */
  readonly bootstrapDevices?: ReadonlyArray<BootstrapDevice>;
  /** A persisted §14.5 compaction base to resume from (WS-S.7): the engine seeds
   *  it, then `load` ingests only the post-snapshot envelopes still in storage. */
  readonly base?: PersistedSnapshotBase;
}

/**
 * A private-room engine over a single room's accepted op set + state.  Build via
 * `PrivateRoomEngine.load` (which re-verifies stored envelopes); feed peer blocks
 * to `ingest`; author with `applyLocalOp`.
 */
export class PrivateRoomEngine {
  private readonly roomId: string;
  private readonly roomIdCommitment: Uint8Array;
  private readonly storage: PrivateRoomStorage;
  private epochs: Map<number, HeldEpochKeys>;
  private readonly bootstrapDevices: readonly BootstrapDevice[];
  /** op_id → accepted op (the reducer's POST-snapshot input set). */
  private readonly acceptedOps = new Map<string, PrivateRoomOp>();
  /** op_id → the WINNING envelope's signature — so a device fork (a second valid
   *  envelope with the same op_id but different content) is resolved deterministically
   *  (keep the bytewise-smaller signature) instead of order-dependently. */
  private readonly acceptedSignatures = new Map<string, string>();
  private currentState: RoomReducerState;
  /** The §14.5 snapshot base (a compacted prefix's reduced state), if any. */
  private baseState: RoomReducerState | undefined;
  /** The covered heads the base represents (the frontier of the compacted set). */
  private baseHeads: readonly string[] = [];
  /** Covered op id → its `lamport` (decimal string) — re-received covered ops are
   *  ignored, AND a post-snapshot op whose parent is covered is causality-checked
   *  against the RETAINED lamport (§14.3.1), identically to an uncompacted peer. */
  private readonly coveredOpLamports = new Map<string, string>();
  /** Envelopes that OPENED-failed for a RECOVERABLE reason (`no_epoch_key` — the
   *  epoch key is not held yet; `unknown_device` — the device cert is not folded
   *  yet), keyed by signature.  Retained so they re-open automatically once the
   *  missing material arrives (a later commit's epoch key via `addEpochKeys`, or an
   *  earlier op that adds the device), instead of being dropped — the fix that lets
   *  cross-epoch content converge and stops the sync session re-requesting forever. */
  private readonly pendingEnvelopes = new Map<string, PrivateEncryptedEnvelope>();
  /** The max Lamport among compacted ops — so authored ops stay globally
   *  monotonic after pruning (a compacted + an uncompacted device must agree on
   *  canonical order, §14.3.1). */
  private baseMaxLamport = 0n;
  /** The max `author_seq` per device among compacted ops (preserved across
   *  pruning so seqs stay monotonic for §15 fork detection). */
  private readonly baseAuthorSeq = new Map<string, number>();
  /** The current base's sealed snapshot body (the bytes the in-band §14.5
   *  `snapshot.commit` references) — retained verbatim so `exportArchive` ships the
   *  exact body the commit's `snapshot_body_cid` covers. */
  private sealedSnapshot: SealedSnapshotWire | undefined;

  private constructor(params: PrivateRoomEngineParams, openedBase?: OpenedSnapshotBase) {
    this.roomId = params.roomId;
    this.roomIdCommitment = params.roomIdCommitment;
    this.storage = params.storage;
    this.epochs = new Map(params.epochs);
    this.bootstrapDevices = params.bootstrapDevices ?? [];
    if (openedBase) {
      // Resume from a §14.5 base (opened from its sealed body): its covered
      // envelopes were pruned from storage, so only the post-snapshot envelopes
      // will be re-verified, and a covered parent's retained lamport is reused.
      this.baseState = openedBase.state;
      this.baseHeads = [...openedBase.coveredHeads];
      for (const [id, lamport] of openedBase.coveredOps) this.coveredOpLamports.set(id, lamport);
      this.baseMaxLamport = BigInt(openedBase.maxLamport);
      for (const [device, seq] of openedBase.authorSeq) this.baseAuthorSeq.set(device, seq);
      this.sealedSnapshot = openedBase.sealedSnapshot;
    }
    this.currentState = reduceRoom([], this.baseState);
  }

  /**
   * Re-fold the post-snapshot ops onto the (optional) snapshot base.  The §14.2
   * structural pre-pass runs FIRST (over the compaction base) so only structurally
   * valid ops reach the fold: a device fork (same `author_seq`), a non-causal
   * `lamport`, an op with a genuinely missing parent, a duplicate `op_id`, or a
   * room mismatch never influences state — even though its envelope opened
   * cryptographically.  `openOp` proves WHO authored an op; `validateStructure`
   * proves the op is a well-formed DAG node before `reduceRoom` applies authority.
   * Crypto-valid-but-structurally-invalid ops stay in `acceptedOps` (retained as
   * §15 fork evidence + so a later-arriving parent can resolve a child), but they
   * do not contribute to `currentState`.
   */
  private refold(): void {
    this.currentState = reduceRoom(this.structurallyAccepted(), this.baseState);
  }

  /** The structurally-valid subset of the accepted ops, in canonical order (the
   *  §14.2 pre-pass over the compaction base), ready for the fold. */
  private structurallyAccepted(): PrivateRoomOp[] {
    return validateStructure([...this.acceptedOps.values()], this.roomId, {
      knownOpLamports: this.coveredOpLamports,
      deviceSeqFloor: this.baseAuthorSeq,
    }).accepted;
  }

  /** Open a persisted §14.5 base (its sealed body) under the held epoch key. */
  private static async openBase(
    params: PrivateRoomEngineParams,
  ): Promise<OpenedSnapshotBase | undefined> {
    if (!params.base) return undefined;
    const sealed = params.base.sealedSnapshot;
    const epoch = params.epochs.get(sealed.epoch);
    if (!epoch) {
      throw new Error(
        `PrivateRoomEngine.load: no epoch key for snapshot base epoch ${sealed.epoch}`,
      );
    }
    const bundle = await openSnapshotBundle(sealed, {
      roomIdCommitment: params.roomIdCommitment,
      contentWrapKey: epoch.contentWrapKey,
      epoch: sealed.epoch,
    });
    return {
      state: deserializeReducerState(bundle.serializedState),
      coveredOps: bundle.coveredOps,
      coveredHeads: bundle.coveredHeads,
      maxLamport: bundle.maxLamport,
      authorSeq: bundle.authorSeq,
      sealedSnapshot: sealed,
    };
  }

  /** Create an engine and rehydrate it by re-verifying every stored envelope. */
  static async load(params: PrivateRoomEngineParams): Promise<PrivateRoomEngine> {
    const engine = new PrivateRoomEngine(params, await PrivateRoomEngine.openBase(params));
    const stored = await params.storage.listEnvelopes();
    await engine.ingest(stored.map((s) => s.envelope));
    return engine;
  }

  /** The current reduced room state (a fresh fold over the accepted set). */
  state(): RoomReducerState {
    return this.currentState;
  }

  /** The head-view union the §15.6 frontier is computed over: the compaction base's
   *  covered heads as parentless roots PLUS the post-snapshot STRUCTURALLY-VALID
   *  ops, so a base head stays a head until a valid op references it.  A crypto-
   *  opened-but-structurally-invalid op (a child ahead of its parent) is excluded —
   *  it must never be a frontier head a new op (or a snapshot) would build on. */
  private headViews(): { op_id: string; parents: readonly string[] }[] {
    return [
      ...this.baseHeads.map((opId) => ({ op_id: opId, parents: [] as string[] })),
      ...this.structurallyAccepted().map((op) => ({ op_id: op.op_id, parents: op.parents })),
    ];
  }

  /** The accepted-DAG heads (the §15.6 announcement frontier), base-aware. */
  heads(): string[] {
    return computeHeads(this.headViews());
  }

  /** The latest accepted §14.5 snapshot id (the highest-Lamport `snapshot.commit`),
   *  surfaced in the head announcement so a peer can discover the retained frontier. */
  latestSnapshotId(): string | undefined {
    let latest: { id: string; lamport: bigint } | undefined;
    for (const op of this.acceptedOps.values()) {
      if (op.body.type !== 'snapshot.commit') continue;
      const lamport = BigInt(op.lamport);
      if (!latest || lamport > latest.lamport) latest = { id: op.body.snapshot_id, lamport };
    }
    return latest?.id;
  }

  /** Add/replace the keys for an epoch (e.g. after an MLS commit rotates them). */
  addEpochKeys(epoch: number, keys: HeldEpochKeys): void {
    this.epochs.set(epoch, keys);
  }

  /**
   * Tier-2 rendezvous cap (§11): the published device commitments (the converged
   * `rendezvous.request` state) — the input an admin issues from. Excludes removed devices.
   */
  rendezvousCommitments(): { deviceId: string; commitmentWithProof: string }[] {
    const out: { deviceId: string; commitmentWithProof: string }[] = [];
    for (const device of this.currentState.devices.values()) {
      if (!device.removed && device.rendezvousCommitment !== undefined) {
        out.push({ deviceId: device.deviceId, commitmentWithProof: device.rendezvousCommitment });
      }
    }
    return out;
  }

  /**
   * Tier-2 rendezvous cap (§11): the accepted `rendezvous.issue` op bodies — what a device
   * installs its credential from (the carrier feeds these to the coordinator's
   * `installFromIssuances`). Returned in acceptance order (latest-wins downstream).
   */
  rendezvousIssuances(): {
    target_epoch: number;
    issuer_public_key: string;
    credentials: ReadonlyArray<{ device_id: string; signature: string }>;
  }[] {
    const out: {
      target_epoch: number;
      issuer_public_key: string;
      credentials: ReadonlyArray<{ device_id: string; signature: string }>;
    }[] = [];
    for (const op of this.acceptedOps.values()) {
      if (op.body.type === 'rendezvous.issue') {
        out.push({
          target_epoch: op.body.target_epoch,
          issuer_public_key: op.body.issuer_public_key,
          credentials: op.body.credentials,
        });
      }
    }
    return out;
  }

  /** The next Lamport stamp to author locally: `max(accepted) + 1` (a decimal
   *  string, big-int-safe, §14.3.1) so a new op strictly succeeds every op the
   *  device has seen. */
  nextLamport(): string {
    let max = this.baseMaxLamport;
    for (const op of this.acceptedOps.values()) {
      const value = BigInt(op.lamport);
      if (value > max) max = value;
    }
    return (max + 1n).toString();
  }

  /** The next `author_seq` for a device: `max(its accepted seqs) + 1` (the §10.4
   *  per-device monotonic counter), so re-authoring after a reload never reuses a
   *  sequence number. */
  nextAuthorSeq(deviceId: string): number {
    const fromBase = this.baseAuthorSeq.get(deviceId);
    let next = fromBase === undefined ? 0 : fromBase + 1;
    for (const op of this.acceptedOps.values()) {
      if (op.author_device_id === deviceId && op.author_seq >= next) next = op.author_seq + 1;
    }
    return next;
  }

  /**
   * Ingest encrypted envelopes (from a peer, an archive import, or local seal).
   * Runs the bounded open→fold→rebuild-context FIXPOINT so an in-batch causal
   * order converges, persists every newly-accepted envelope, and re-folds state.
   * Quarantines (never renders) what cannot be opened.
   */
  async ingest(envelopes: readonly PrivateEncryptedEnvelope[]): Promise<IngestReport> {
    // Pending pool keyed by the envelope signature (unique per signed op).  Seed it
    // with the RETAINED recoverable-failure envelopes so a newly-arrived epoch key or
    // device cert re-opens them in the SAME fixpoint as the new batch (so `ingest([])`
    // after `addEpochKeys` drains them — the cross-epoch self-heal).
    const pending = new Map<string, PrivateEncryptedEnvelope>(this.pendingEnvelopes);
    for (const envelope of envelopes) pending.set(envelope.signature, envelope);

    const accepted: string[] = [];
    const forks: QuarantinedEnvelope[] = [];
    let lastResultByKey = new Map<string, OpIntakeRejection>();

    let progressed = true;
    while (progressed && pending.size > 0) {
      progressed = false;
      const ctx = await buildOpIntakeContext({
        state: this.currentState,
        roomIdCommitment: this.roomIdCommitment,
        epochs: this.epochs,
        extraDevices: this.bootstrapDevices,
      });
      const reasons = new Map<string, OpIntakeRejection>();
      for (const [key, envelope] of pending) {
        const result = await openOp(envelope, ctx);
        if (!result.ok) {
          reasons.set(key, result.reason);
          continue;
        }
        pending.delete(key);
        this.pendingEnvelopes.delete(key); // resolved — no longer awaiting material
        progressed = true;
        const opId = result.op.op_id;
        // A re-received op already folded into the snapshot base is a no-op.
        if (this.coveredOpLamports.has(opId)) continue;
        const existingSig = this.acceptedSignatures.get(opId);
        if (existingSig === undefined) {
          this.acceptedOps.set(opId, result.op);
          this.acceptedSignatures.set(opId, envelope.signature);
          accepted.push(opId);
          await this.storage.putEnvelope(opId, envelope);
          continue;
        }
        if (existingSig === envelope.signature) continue; // exact idempotent re-receive
        // A device FORK: two valid envelopes, same op_id, different signed content.
        // Keep the bytewise-smaller signature so every peer converges on the SAME
        // variant regardless of arrival order; the loser is fork evidence, excluded
        // from state — never silently dropped by "first one wins".
        if (envelope.signature < existingSig) {
          this.acceptedOps.set(opId, result.op);
          this.acceptedSignatures.set(opId, envelope.signature);
          await this.storage.putEnvelope(opId, envelope); // overwrite with the winner
        } else {
          forks.push({ envelope, reason: 'duplicate_op_id' });
        }
      }
      lastResultByKey = reasons;
      // Re-fold (onto the snapshot base) so the next pass resolves devices/keys
      // added by this pass.
      if (progressed) this.refold();
    }

    // Partition the still-unopened: RECOVERABLE failures (missing epoch key / device
    // cert) are RETAINED for automatic retry when the material arrives; everything else
    // (bad signature, AEAD failure, schema reject, fork loser) is quarantined for good.
    const quarantined: QuarantinedEnvelope[] = [...forks];
    for (const [key, envelope] of pending) {
      const reason = lastResultByKey.get(key) ?? ('unknown_device' as IngestQuarantineReason);
      if (reason === 'no_epoch_key' || reason === 'unknown_device') {
        this.pendingEnvelopes.set(key, envelope); // awaiting an epoch key / device cert
      } else {
        this.pendingEnvelopes.delete(key);
        quarantined.push({ envelope, reason });
      }
    }
    // §27 DoS bound: cap the retention pool (an unauthenticated peer cannot verify-fail
    // an `unknown_device` envelope, so it could otherwise flood the pool unbounded).
    // Evict oldest-first (Map insertion order); an evicted legitimate pending op is
    // re-fetched by the §15.7 walk, so eviction never loses content permanently.
    while (this.pendingEnvelopes.size > MAX_PENDING_ENVELOPES) {
      const oldest = this.pendingEnvelopes.keys().next().value;
      if (oldest === undefined) break;
      this.pendingEnvelopes.delete(oldest);
    }
    return { accepted, quarantined };
  }

  /** Re-attempt the retained recoverable-failure envelopes (e.g. after `addEpochKeys`
   *  delivers a new epoch key, or an earlier op folds a device cert).  A no-op when
   *  nothing is pending.  Returns what newly opened. */
  retryPending(): Promise<IngestReport> {
    return this.ingest([]);
  }

  /** How many envelopes are held-but-not-yet-openable (awaiting an epoch key / device
   *  cert).  A non-zero count after sync quiesces means "blocked on a key" — the live
   *  session surfaces this rather than re-requesting forever. */
  pendingCount(): number {
    return this.pendingEnvelopes.size;
  }

  /**
   * Author a local op: seal it under `sealParams`, then ingest the resulting
   * envelope (so it passes the SAME verify path as a peer block — the author's
   * own ops are not privileged).  Returns the ingest report for that one op.
   */
  async applyLocalOp(op: PrivateRoomOp, sealParams: SealOpParams): Promise<IngestReport> {
    if (op.room_id !== this.roomId) {
      throw new Error('applyLocalOp: op.room_id does not match the engine room');
    }
    const envelope = await sealOp(op, sealParams);
    return this.ingest([envelope]);
  }

  // --- §15.6 sync surface (the transport drives these) ----------------------

  /** The §15.6 head announcement to send a peer (the engine's frontier + a coarse
   *  op-count + the latest verified snapshot id).  Built over the base-aware head
   *  views so a COMPACTED room still announces its retained frontier (§15.6) — a
   *  peer would otherwise think a compacted room has nothing to fetch. */
  headAnnouncement(latestSnapshotId?: string): HeadAnnouncement {
    const snapshotId = latestSnapshotId ?? this.latestSnapshotId();
    return buildHeadAnnouncement({
      acceptedOps: this.headViews(),
      ...(snapshotId === undefined ? {} : { latestSnapshotId: snapshotId }),
    });
  }

  /** Given a peer's §15.6 announcement, the head op ids the engine still wants
   *  (the first §15.7 reconciliation step; fetched heads then feed `ingest`). */
  wantedFrom(announcement: HeadAnnouncement): string[] {
    return wantedHeads(new Set(this.acceptedOps.keys()), announcement);
  }

  /**
   * The §15.7 frontier-first ancestor walk: op ids referenced as a parent by an
   * OPENED op but NOT yet held (base-aware).  After ingesting a batch of heads, a
   * structurally-invalid (parent-missing) op is RETAINED in `acceptedOps`, so its
   * unmet parents surface here; the sync session requests them, ingests, and
   * recomputes until this is empty — at which point the engine holds the causal
   * closure and the retained ops fold into state.  Deterministic (sorted, deduped).
   */
  missingDependencies(): string[] {
    const known = new Set<string>(this.acceptedOps.keys());
    for (const id of this.coveredOpLamports.keys()) known.add(id);
    const views = [...this.acceptedOps.values()].map((op) => ({
      op_id: op.op_id,
      parents: op.parents,
    }));
    return missingParents(known, views);
  }

  /**
   * Serve the §15.7 op-exchange request: the WINNING envelopes the engine holds for
   * the requested op ids (a peer fetches these, then runs them through its OWN
   * `ingest` — storage confers no trust, §8.3).  Reads the persisted envelopes (the
   * fork-resolution winner is the one stored), so a covered/compacted op the engine
   * no longer stores is simply not served (the requester gets it via the snapshot
   * base in an archive).  Bounded by the request set.
   */
  async serveOps(opIds: readonly string[]): Promise<PrivateEncryptedEnvelope[]> {
    if (opIds.length === 0) return [];
    const want = new Set(opIds);
    const out: PrivateEncryptedEnvelope[] = [];
    for (const { opId, envelope } of await this.storage.listEnvelopes()) {
      if (want.has(opId)) out.push(envelope);
    }
    return out;
  }

  // --- §13.6 / §15.7 media block exchange -----------------------------------

  /**
   * Persist a freshly-encrypted §13.6 attachment's blocks (the sealed manifest + every
   * sealed chunk, CID-addressed).  The author then issues an `attachment.add` op carrying
   * `manifest_cid` + `wrapped_object_key`; peers fetch these blocks lazily by CID.
   */
  async storeAttachment(encrypted: EncryptedAttachment): Promise<void> {
    await this.storage.putBlock(encrypted.manifestCid, encrypted.sealedManifest);
    for (const [cid, bytes] of encrypted.chunks) await this.storage.putBlock(cid, bytes);
  }

  /** Open a stored attachment manifest under its wrapping epoch's key, or `undefined`
   *  if the block is missing, the epoch key is unheld, or it fails to open. */
  private async tryOpenManifest(att: {
    readonly attachmentId: string;
    readonly manifestCid: string;
    readonly wrappedObjectKey: string;
    readonly epoch: number;
  }): Promise<Awaited<ReturnType<typeof openAttachmentManifest>> | undefined> {
    const sealed = await this.storage.getBlock(att.manifestCid);
    const epoch = this.epochs.get(att.epoch);
    if (!sealed || !epoch) return undefined;
    try {
      return await openAttachmentManifest(
        sealed,
        att.attachmentId,
        {
          roomIdCommitment: this.roomIdCommitment,
          roomEpoch: att.epoch,
          contentWrapKey: epoch.contentWrapKey,
        },
        { wrappedObjectKey: fromBase64Url(att.wrappedObjectKey) },
      );
    } catch {
      return undefined;
    }
  }

  /**
   * §15.8 — the CIDs this engine still needs to render its attachments: every
   * `attachment.add`'s manifest CID it lacks, then (once a manifest is held + opens) that
   * manifest's chunk CIDs it lacks.  Two-phase, because chunk CIDs live INSIDE the
   * encrypted manifest — so a peer first fetches manifests, then their chunks.
   */
  async wantedBlockCids(): Promise<string[]> {
    const wanted: string[] = [];
    for (const att of this.currentState.attachments.values()) {
      if (!(await this.storage.hasBlock(att.manifestCid))) {
        wanted.push(att.manifestCid);
        continue; // chunk CIDs are unknown until the manifest is held + opened
      }
      const manifest = await this.tryOpenManifest(att);
      if (!manifest) continue;
      for (const chunk of manifest.encrypted_chunks) {
        if (!(await this.storage.hasBlock(chunk.cid))) wanted.push(chunk.cid);
      }
    }
    return wanted;
  }

  /**
   * §15.7 — serve requested blocks up to `maxBytes` (the requester's budget).  `refused`
   * lists ONLY blocks held-but-over-budget (so the requester re-requests them on the next
   * pass — the §15.8 multi-pass fetch of an attachment larger than one request's budget).
   * A block this engine does NOT hold is OMITTED entirely (neither served nor refused), so
   * the requester leaves it in its request guard and does not livelock re-asking for a
   * block the peer will never have.
   */
  async serveBlocks(
    cids: readonly string[],
    maxBytes: number,
  ): Promise<{ served: { cid: string; bytes: Uint8Array }[]; refused: string[] }> {
    const served: { cid: string; bytes: Uint8Array }[] = [];
    const refused: string[] = [];
    let total = 0;
    for (const cid of cids) {
      const bytes = await this.storage.getBlock(cid);
      if (!bytes) continue; // not held → omit (the requester keeps it guarded; no livelock)
      if (total + bytes.length > maxBytes) {
        refused.push(cid); // held but over budget → re-requestable next pass
        continue;
      }
      total += bytes.length;
      served.push({ cid, bytes });
    }
    return { served, refused };
  }

  /**
   * Ingest fetched blocks, VERIFYING each block's CID over its bytes BEFORE storing
   * (§8.3 — the wire confers no trust; a wrong-CID block is rejected, never stored).
   */
  async ingestBlocks(
    blocks: readonly { cid: string; bytes: Uint8Array }[],
  ): Promise<{ accepted: string[]; rejected: string[] }> {
    const accepted: string[] = [];
    const rejected: string[] = [];
    for (const { cid, bytes } of blocks) {
      if (await verifyPrivateCid(bytes, cid, PRIVATE_CID_CODEC.raw)) {
        await this.storage.putBlock(cid, bytes);
        accepted.push(cid);
      } else {
        rejected.push(cid);
      }
    }
    return { accepted, rejected };
  }

  /**
   * Decrypt + reassemble a stored attachment into its plaintext media bytes, or
   * `undefined` if the manifest or any chunk is not yet fetched / the epoch key is
   * unheld.  Every chunk's ciphertext CID + AEAD + plaintext commitment is re-verified
   * (decryptAttachment) — fail-closed on tamper.
   */
  async openAttachment(attachmentId: string): Promise<Uint8Array | undefined> {
    const att = this.currentState.attachments.get(attachmentId);
    if (!att) return undefined;
    const manifest = await this.tryOpenManifest(att);
    const epoch = this.epochs.get(att.epoch);
    if (!manifest || !epoch) return undefined;
    const chunksByCid = new Map<string, Uint8Array>();
    for (const chunk of manifest.encrypted_chunks) {
      const bytes = await this.storage.getBlock(chunk.cid);
      if (!bytes) return undefined; // not all chunks fetched yet
      chunksByCid.set(chunk.cid, bytes);
    }
    return decryptAttachment(
      manifest,
      chunksByCid,
      {
        roomIdCommitment: this.roomIdCommitment,
        roomEpoch: att.epoch,
        contentWrapKey: epoch.contentWrapKey,
      },
      { wrappedObjectKey: fromBase64Url(att.wrappedObjectKey) },
    );
  }

  // --- §15.9 offline archive (export / import) ------------------------------

  /**
   * Export the room as a §15.9 ciphertext-only archive (`encrypted_member_backup`
   * | `voluntary_report`) for offline sharing.  Carries the retained envelopes AND
   * — for a COMPACTED room — the §14.5 SEALED snapshot body, so an importer that
   * never held the pruned ops can still bootstrap (it verifies the body against the
   * in-band `snapshot.commit`).  Throws if the room holds nothing to export.
   */
  async exportArchive(params: {
    readonly kind: PrivateArchiveKind;
    readonly createdAtBucket: string;
  }): Promise<Uint8Array> {
    const stored = await this.storage.listEnvelopes();
    if (stored.length === 0) throw new Error('exportArchive: the room has no content to export');
    const archive = buildBlockArchive({
      kind: params.kind,
      roomIdHash: toBase64Url(this.roomIdCommitment),
      createdAtBucket: params.createdAtBucket,
      envelopes: stored.map((s) => s.envelope),
      ...(this.sealedSnapshot ? { sealedSnapshot: this.sealedSnapshot } : {}),
    });
    return encodeBlockArchive(archive);
  }

  /**
   * §15.6 — serve this room's archive to a peer that requested a LIVE snapshot bootstrap
   * (a compacted/lagging member that cannot fetch the pruned prefix op-by-op): the
   * retained §14.5 sealed snapshot + post-snapshot envelopes, which the requester adopts
   * via `importArchive` (re-verifying the in-band commit).  `undefined` when there is no
   * compaction base to bootstrap from (a peer then just continues the op walk).
   */
  async snapshotArchive(): Promise<Uint8Array | undefined> {
    if (this.sealedSnapshot === undefined) return undefined;
    try {
      return await this.exportArchive({
        kind: 'encrypted_member_backup',
        createdAtBucket: 'snapshot-serve',
      });
    } catch {
      return undefined;
    }
  }

  /**
   * Import a §15.9 archive into this room: decode under caps, confirm it is for
   * THIS room, bootstrap from its §14.5 sealed snapshot if present (so a compacted
   * room imports without its pruned ops), then `ingest` every envelope (re-
   * validated — the container confers no trust).  Rejects an archive for a
   * different room.
   */
  async importArchive(bytes: Uint8Array): Promise<IngestReport> {
    const archive = decodeBlockArchive(bytes);
    if (archive.room_id_hash !== toBase64Url(this.roomIdCommitment)) {
      throw new Error('importArchive: archive is for a different room');
    }
    // Bootstrap from a sealed snapshot when this engine holds no base yet (a fresh
    // restore OR a lagging member that walked some post-snapshot ops but cannot reach the
    // pruned prefix op-by-op) — adopt it ONLY if it verifies against its in-band commit;
    // any already-accepted ops re-fold onto the new base.  A device that ALREADY has a
    // base keeps it (it already holds a covered prefix).
    if (archive.sealed_snapshot && !this.sealedSnapshot && this.coveredOpLamports.size === 0) {
      await this.bootstrapFromSnapshot(archive.sealed_snapshot, archive.envelopes);
    }
    return this.ingest(archive.envelopes);
  }

  // --- §14.5 snapshots + §25.6 compaction -----------------------------------

  /** The §14.5 verifiable state root over the CURRENT reduced state — equal
   *  logical state ⇒ equal root (a peer re-verifies it against the covered ops). */
  async stateRoot(): Promise<string> {
    return toBase64Url(await sha256(roomStateCommitment(this.currentState)));
  }

  /**
   * Build a §14.5 snapshot of the CURRENT state over the structurally-ACCEPTED
   * prefix: the body (full state + the structural metadata an importer needs —
   * every covered op's lamport, the covered heads, the Lamport ceiling, the seq
   * floor), the state root, and the covered (op id → lamport) set.  A crypto-
   * opened-but-structurally-invalid op (e.g. a child ahead of its parent) is NOT
   * covered, so compacting can never permanently suppress it.
   */
  private async buildSnapshot(): Promise<SnapshotResult> {
    const accepted = this.structurallyAccepted();
    const coveredOps: [string, string][] = [
      ...this.coveredOpLamports,
      ...accepted.map((op): [string, string] => [op.op_id, op.lamport]),
    ];
    let maxLamport = this.baseMaxLamport;
    const authorSeq = new Map(this.baseAuthorSeq);
    for (const op of accepted) {
      const lamport = BigInt(op.lamport);
      if (lamport > maxLamport) maxLamport = lamport;
      const seq = authorSeq.get(op.author_device_id);
      if (seq === undefined || op.author_seq > seq)
        authorSeq.set(op.author_device_id, op.author_seq);
    }
    const coveredHeads = this.heads();
    const bundle: SnapshotBundle = {
      serializedState: serializeReducerState(this.currentState),
      coveredOps,
      coveredHeads,
      maxLamport: maxLamport.toString(),
      authorSeq: [...authorSeq],
    };
    return { bundle, stateRoot: await this.stateRoot(), coveredOps, coveredHeads };
  }

  /**
   * §14.5 in-band snapshot + §25.6 compaction: seal the current snapshot body
   * under the epoch key, author an admin-signed `snapshot.commit` op (carrying the
   * state root + covered heads + the body CID), then prune the covered ops and
   * adopt the base.  The sealed body is retained verbatim (its CID is the one the
   * commit references) so `exportArchive` ships an importer-verifiable snapshot.
   * Returns the persistable base.  The author must hold the `admin` capability
   * (the reducer rejects the commit otherwise — then nothing is compacted).
   */
  async commitSnapshot(params: CommitSnapshotParams): Promise<PersistedSnapshotBase | undefined> {
    const snapshot = await this.buildSnapshot();
    // Nothing structurally-accepted to cover (e.g. every accepted op is awaiting a
    // missing parent) ⇒ no frontier to commit; the `snapshot.commit` op requires
    // ≥1 `includes_ops_up_to`, so skip rather than throw on the schema.
    if (snapshot.coveredHeads.length === 0) return undefined;
    const sealed = await sealSnapshotBundle(snapshot.bundle, {
      roomIdCommitment: this.roomIdCommitment,
      contentWrapKey: params.contentWrapKey,
      epoch: params.epoch,
    });
    const createdAt = params.createdAt ?? new Date().toISOString();
    const sealParams: SealOpParams = {
      roomIdCommitment: this.roomIdCommitment,
      contentWrapKey: params.contentWrapKey,
      deviceSigningKey: params.author.signingKey,
      authorDeviceIdBlind: await deriveAuthorDeviceIdBlind(
        params.roomEpochSecret,
        this.roomIdCommitment,
        params.author.deviceId,
        params.epoch,
      ),
      capabilityRootAtSeq: await sha256(canonical([])),
    };
    const op = privateRoomOpSchema.parse({
      schema: 'licio.private.op.v1',
      room_id: this.roomId,
      epoch: params.epoch,
      op_id: params.opId,
      author_member_id: params.author.memberId,
      author_device_id: params.author.deviceId,
      author_seq: this.nextAuthorSeq(params.author.deviceId),
      created_at: createdAt,
      created_at_bucket: createdAt.slice(0, 13),
      lamport: this.nextLamport(),
      parents: snapshot.coveredHeads,
      body: {
        type: 'snapshot.commit',
        snapshot_id: params.snapshotId,
        includes_ops_up_to: snapshot.coveredHeads,
        state_merkle_root: snapshot.stateRoot,
        snapshot_body_cid: sealed.cid,
      },
    });
    await this.applyLocalOp(op, sealParams);
    // The commit must be AUTHORIZED (reduced into state — `snapshot.commit` requires
    // `admin`); an unauthorized op opens cryptographically yet the reducer rejects
    // it, so it never reaches `state.snapshots`.  Do NOT compact without it (a
    // snapshot must be backed by an accepted, authorized, in-band commit).
    if (!this.currentState.snapshots.includes(params.snapshotId)) return undefined;
    this.compact(snapshot, sealed);
    await this.storage.deleteEnvelopes(snapshot.coveredOps.map(([id]) => id));
    return { sealedSnapshot: sealed };
  }

  /** Adopt a built snapshot as the fold base + prune the covered ops it summarizes
   *  (the structurally-accepted prefix only). */
  private compact(snapshot: SnapshotResult, sealed: SealedSnapshotWire): void {
    for (const [id, lamport] of snapshot.coveredOps) {
      this.coveredOpLamports.set(id, lamport);
      const value = BigInt(lamport);
      if (value > this.baseMaxLamport) this.baseMaxLamport = value;
      this.acceptedOps.delete(id);
      this.acceptedSignatures.delete(id);
    }
    for (const [device, seq] of snapshot.bundle.authorSeq) {
      const prev = this.baseAuthorSeq.get(device);
      if (prev === undefined || seq > prev) this.baseAuthorSeq.set(device, seq);
    }
    this.baseState = deserializeReducerState(snapshot.bundle.serializedState);
    this.baseHeads = [...snapshot.coveredHeads];
    this.sealedSnapshot = sealed;
    this.refold();
  }

  /**
   * Bootstrap a fresh engine from an imported §14.5 sealed snapshot: open the body
   * under the held epoch key (proving member authorship), then ADOPT it only if its
   * in-band `snapshot.commit` verifies — signed by an `admin` in the body, its
   * `state_merkle_root` equals the body's root, `includes_ops_up_to` matches the
   * body's covered heads, and `snapshot_body_cid` equals the sealed body's CID.  An
   * unverifiable snapshot is NOT adopted (storage/container confers no trust, §8.3).
   */
  private async bootstrapFromSnapshot(
    sealed: SealedSnapshotWire,
    envelopes: readonly PrivateEncryptedEnvelope[],
  ): Promise<void> {
    const epoch = this.epochs.get(sealed.epoch);
    if (!epoch) return;
    let bundle: SnapshotBundle;
    try {
      bundle = await openSnapshotBundle(sealed, {
        roomIdCommitment: this.roomIdCommitment,
        contentWrapKey: epoch.contentWrapKey,
        epoch: sealed.epoch,
      });
    } catch {
      return; // body did not open (tampered / wrong epoch) → do not adopt
    }
    const candidate = deserializeReducerState(bundle.serializedState);
    if (!(await this.verifySnapshotCommit(sealed, bundle, candidate, envelopes))) return;
    this.baseState = candidate;
    this.baseHeads = [...bundle.coveredHeads];
    for (const [id, lamport] of bundle.coveredOps) this.coveredOpLamports.set(id, lamport);
    this.baseMaxLamport = BigInt(bundle.maxLamport);
    for (const [device, seq] of bundle.authorSeq) this.baseAuthorSeq.set(device, seq);
    this.sealedSnapshot = sealed;
    // Re-fold any ALREADY-accepted ops onto the new base (not just `reduceRoom([], base)`):
    // a lagging member that walked some post-snapshot ops before adopting the snapshot
    // must keep them, and they now resolve against the base's covered prefix.
    this.refold();
  }

  /** Whether the imported sealed snapshot is backed by a valid in-band commit. */
  private async verifySnapshotCommit(
    sealed: SealedSnapshotWire,
    bundle: SnapshotBundle,
    candidate: RoomReducerState,
    envelopes: readonly PrivateEncryptedEnvelope[],
  ): Promise<boolean> {
    const expectedRoot = toBase64Url(await sha256(roomStateCommitment(candidate)));
    const expectedHeads = [...bundle.coveredHeads].sort();
    // SECURITY (§14.5): anchor the commit author's AUTHORITY (its device cert + its
    // `admin` capability) in state we ALREADY trust, NOT in the candidate body we are
    // deciding whether to adopt.  The body is only AEAD-sealed under the per-epoch
    // content-wrap key — which EVERY member holds — so the seal proves "a member made
    // this", never "an admin".  A malicious member could otherwise craft a body naming
    // itself admin + author a self-validating snapshot.commit, escalating privilege on
    // the importer.  So we resolve the author against `this.currentState` (the importer's
    // own reduced state — an established/reconnecting member knows the real admins); a
    // forged author is then absent/non-admin there and rejected.  Only when the importer
    // has NO prior membership (a FRESH completeJoin, where the snapshot arrived in a GRANT
    // delivered + authenticated over the §10.3 channel of the admin being joined) do we
    // fall back to the body — trust-by-delivery from the inviting admin.
    const authority = this.currentState.members.size > 0 ? this.currentState : candidate;
    const ctx = await buildOpIntakeContext({
      state: authority,
      roomIdCommitment: this.roomIdCommitment,
      epochs: this.epochs,
      extraDevices: this.bootstrapDevices,
    });
    for (const envelope of envelopes) {
      if (envelope.object_type !== 'snapshot') continue;
      const result = await openOp(envelope, ctx);
      if (!result.ok || result.op.body.type !== 'snapshot.commit') continue;
      const body = result.op.body;
      if (body.snapshot_body_cid !== sealed.cid) continue;
      if (body.state_merkle_root !== expectedRoot) continue;
      if (!sameStrings([...body.includes_ops_up_to].sort(), expectedHeads)) continue;
      const member = authority.members.get(result.op.author_member_id);
      if (!member || member.removed) continue;
      if (!member.capabilities.has(OP_REQUIRED_CAPABILITY['snapshot.commit'])) continue;
      return true;
    }
    return false;
  }

  /**
   * §25.6 cadence helper: when the post-snapshot op count reaches `threshold`,
   * author the in-band snapshot + compact + DROP the covered envelopes, returning
   * the base for the caller to persist.  Below threshold (or if the author lacks
   * `admin`) it is a no-op (`undefined`).  Bounds replay-fold + re-verify cost.
   */
  async maybeCompact(
    threshold: number,
    params: CommitSnapshotParams,
  ): Promise<PersistedSnapshotBase | undefined> {
    if (threshold < 1 || this.acceptedOps.size < threshold) return undefined;
    return this.commitSnapshot(params);
  }

  /**
   * Export the current §14.5 compaction base (the sealed snapshot body) for at-rest
   * persistence, or `undefined` if nothing has been compacted yet.  On reload it is
   * passed back as `params.base`; the engine opens it under the held epoch key and
   * folds only the post-snapshot envelopes on top.
   */
  exportBase(): PersistedSnapshotBase | undefined {
    return this.sealedSnapshot ? { sealedSnapshot: this.sealedSnapshot } : undefined;
  }
}

/** Parameters for authoring an in-band §14.5 `snapshot.commit` (admin-signed).
 *  The engine seals the snapshot body + builds the commit op + its seal params
 *  internally (the body CID depends on the seal, so the caller cannot pre-build it). */
export interface CommitSnapshotParams {
  /** The epoch the snapshot body is sealed under + the commit is authored under. */
  readonly epoch: number;
  /** That epoch's secret (to derive the §10.4 author-device blind) + content-wrap
   *  key (to seal the body + the commit). */
  readonly roomEpochSecret: Uint8Array;
  readonly contentWrapKey: Uint8Array;
  /** The committing admin device (the reducer rejects the commit without `admin`). */
  readonly author: {
    readonly memberId: string;
    readonly deviceId: string;
    readonly signingKey: CryptoKey;
  };
  readonly opId: string;
  readonly snapshotId: string;
  /** ISO timestamp for the commit op (defaults to now). */
  readonly createdAt?: string;
}

/** Equal string arrays (order-sensitive — callers sort first). */
function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
