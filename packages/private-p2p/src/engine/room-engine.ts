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

import { toBase64Url } from '../crypto/runtime.js';
import {
  type BootstrapDevice,
  buildOpIntakeContext,
  type HeldEpochKeys,
} from '../reducer/intake-context.js';
import { reduceRoom } from '../reducer/reduce.js';
import type { RoomReducerState } from '../reducer/state.js';
import {
  type OpIntakeRejection,
  openOp,
  type SealOpParams,
  sealOp,
} from '../reducer/validate-op.js';
import type { PrivateEncryptedEnvelope } from '../schemas/envelope.js';
import type { PrivateRoomOp } from '../schemas/ops.js';
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
  wantedHeads,
} from '../sync/head-sync.js';

/** The durable boundary for a room's encrypted envelopes (keyed by op id). */
export interface PrivateRoomStorage {
  /** Persist an ACCEPTED envelope under its op id (idempotent — same id, same bytes). */
  putEnvelope(opId: string, envelope: PrivateEncryptedEnvelope): Promise<void>;
  /** Every stored envelope (re-verified on load — storage confers no trust). */
  listEnvelopes(): Promise<ReadonlyArray<{ opId: string; envelope: PrivateEncryptedEnvelope }>>;
}

/** An in-memory `PrivateRoomStorage` (local/dev + tests; apps/web uses IndexedDB). */
export class InMemoryPrivateRoomStorage implements PrivateRoomStorage {
  private readonly envelopes = new Map<string, PrivateEncryptedEnvelope>();

  putEnvelope(opId: string, envelope: PrivateEncryptedEnvelope): Promise<void> {
    if (!this.envelopes.has(opId)) this.envelopes.set(opId, envelope);
    return Promise.resolve();
  }

  listEnvelopes(): Promise<ReadonlyArray<{ opId: string; envelope: PrivateEncryptedEnvelope }>> {
    return Promise.resolve([...this.envelopes].map(([opId, envelope]) => ({ opId, envelope })));
  }
}

/** A quarantined envelope + the §14.2 stage-1 reason it failed to open. */
export interface QuarantinedEnvelope {
  readonly envelope: PrivateEncryptedEnvelope;
  readonly reason: OpIntakeRejection;
}

/** The outcome of an `ingest` / `applyLocalOp` call. */
export interface IngestReport {
  /** Op ids newly accepted into state by this call. */
  readonly accepted: string[];
  /** Envelopes that did not open (unknown device / decrypt failed / …). */
  readonly quarantined: QuarantinedEnvelope[];
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
  /** op_id → accepted op (the reducer's input set). */
  private readonly acceptedOps = new Map<string, PrivateRoomOp>();
  private currentState: RoomReducerState;

  private constructor(params: PrivateRoomEngineParams) {
    this.roomId = params.roomId;
    this.roomIdCommitment = params.roomIdCommitment;
    this.storage = params.storage;
    this.epochs = new Map(params.epochs);
    this.bootstrapDevices = params.bootstrapDevices ?? [];
    this.currentState = reduceRoom([]);
  }

  /** Create an engine and rehydrate it by re-verifying every stored envelope. */
  static async load(params: PrivateRoomEngineParams): Promise<PrivateRoomEngine> {
    const engine = new PrivateRoomEngine(params);
    const stored = await params.storage.listEnvelopes();
    await engine.ingest(stored.map((s) => s.envelope));
    return engine;
  }

  /** The current reduced room state (a fresh fold over the accepted set). */
  state(): RoomReducerState {
    return this.currentState;
  }

  /** The accepted-DAG heads (the §15.6 announcement frontier). */
  heads(): string[] {
    return computeHeads(
      [...this.acceptedOps.values()].map((op) => ({ op_id: op.op_id, parents: op.parents })),
    );
  }

  /** Add/replace the keys for an epoch (e.g. after an MLS commit rotates them). */
  addEpochKeys(epoch: number, keys: HeldEpochKeys): void {
    this.epochs.set(epoch, keys);
  }

  /**
   * Ingest encrypted envelopes (from a peer, an archive import, or local seal).
   * Runs the bounded open→fold→rebuild-context FIXPOINT so an in-batch causal
   * order converges, persists every newly-accepted envelope, and re-folds state.
   * Quarantines (never renders) what cannot be opened.
   */
  async ingest(envelopes: readonly PrivateEncryptedEnvelope[]): Promise<IngestReport> {
    // Pending pool keyed by the envelope signature (unique per signed op).
    const pending = new Map<string, PrivateEncryptedEnvelope>();
    for (const envelope of envelopes) pending.set(envelope.signature, envelope);

    const accepted: string[] = [];
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
        progressed = true;
        const opId = result.op.op_id;
        if (!this.acceptedOps.has(opId)) {
          this.acceptedOps.set(opId, result.op);
          accepted.push(opId);
          await this.storage.putEnvelope(opId, envelope);
        }
      }
      lastResultByKey = reasons;
      // Re-fold so the next pass resolves devices/keys added by this pass.
      if (progressed) this.currentState = reduceRoom([...this.acceptedOps.values()]);
    }

    const quarantined: QuarantinedEnvelope[] = [...pending].map(([key, envelope]) => ({
      envelope,
      reason: lastResultByKey.get(key) ?? 'unknown_device',
    }));
    return { accepted, quarantined };
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

  /** The §15.6 head announcement to send a peer (the engine's frontier + a
   *  coarse op-count, with an optional latest verified snapshot id). */
  headAnnouncement(latestSnapshotId?: string): HeadAnnouncement {
    return buildHeadAnnouncement({
      acceptedOps: [...this.acceptedOps.values()].map((op) => ({
        op_id: op.op_id,
        parents: op.parents,
      })),
      ...(latestSnapshotId === undefined ? {} : { latestSnapshotId }),
    });
  }

  /** Given a peer's §15.6 announcement, the head op ids the engine still wants
   *  (the first §15.7 reconciliation step; fetched heads then feed `ingest`). */
  wantedFrom(announcement: HeadAnnouncement): string[] {
    return wantedHeads(new Set(this.acceptedOps.keys()), announcement);
  }

  // --- §15.9 offline archive (export / import) ------------------------------

  /**
   * Export the room's accepted envelopes as a §15.9 ciphertext-only archive
   * (`encrypted_member_backup` | `voluntary_report`) for offline sharing.
   * Throws if the room holds no ops yet (nothing to export).
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
    });
    return encodeBlockArchive(archive);
  }

  /**
   * Import a §15.9 archive into this room: decode under caps, confirm it is for
   * THIS room, then `ingest` every envelope (re-validated — the container confers
   * no trust).  Rejects an archive for a different room.
   */
  async importArchive(bytes: Uint8Array): Promise<IngestReport> {
    const archive = decodeBlockArchive(bytes);
    if (archive.room_id_hash !== toBase64Url(this.roomIdCommitment)) {
      throw new Error('importArchive: archive is for a different room');
    }
    return this.ingest(archive.envelopes);
  }
}
