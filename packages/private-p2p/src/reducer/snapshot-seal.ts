// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.5.9 / §14.5 — the SEALED snapshot body for cross-device compaction.  A
// §14.5 snapshot must be re-importable on ANOTHER device that never held the
// pruned ops: the snapshot body (the full reduced state PLUS the structural
// metadata an importer needs to keep folding — every covered op's lamport, the
// covered heads, the Lamport ceiling, and the per-device seq floor) is AEAD-sealed
// under the epoch `content_wrap_key` (so only a member can open it) and content-
// addressed.  An admin then authors an in-band `snapshot.commit` op carrying the
// state root + covered heads + this body's CID; the importer opens the body
// (proving member authorship), verifies the commit's root matches it (proving
// integrity), and adopts it as the fold base.  Trust is cryptographic (epoch-key
// possession + the admin signature + the root match), never container membership.

import { z } from 'zod';
import {
  type BodyAadInput,
  openBody,
  sealBody,
  selectPaddingPolicy,
  unwrapKey,
  type WrapAadInput,
  wrapKey,
} from '../crypto/aead.js';
import { computePrivateCid, PRIVATE_CID_CODEC, verifyPrivateCid } from '../crypto/cid.js';
import { fromBase64Url, fromUtf8, toBase64Url, utf8 } from '../crypto/runtime.js';

/** The snapshot-body plaintext schema id (the §14.5 body's `plaintext_schema`). */
export const SNAPSHOT_BODY_SCHEMA = 'licio.private.snapshot.v1';
/** A fixed capability-root domain constant for the snapshot AAD (a snapshot is not
 *  capability-root-gated like an op; the integrity anchor is the commit's root). */
const SNAPSHOT_CAP_ROOT = new Uint8Array(16);

/**
 * A §14.5 snapshot bundle: the serialized reduced state PLUS the structural
 * metadata a compacted/importing device needs to keep making the SAME structural
 * decisions as an uncompacted peer (every covered op's lamport, the covered heads,
 * the Lamport ceiling, and the per-device `author_seq` floor).
 */
export interface SnapshotBundle {
  /** `serializeReducerState(state)` output (the full reduced state). */
  readonly serializedState: Uint8Array;
  /** Every covered op id → its `lamport` (decimal string) — so a pruned parent's
   *  causality check is byte-identical to an uncompacted peer's. */
  readonly coveredOps: ReadonlyArray<readonly [string, string]>;
  /** The covered frontier (`includes_ops_up_to`). */
  readonly coveredHeads: readonly string[];
  /** Max Lamport among covered ops (decimal string). */
  readonly maxLamport: string;
  /** Per-device max `author_seq` among covered ops. */
  readonly authorSeq: ReadonlyArray<readonly [string, number]>;
}

const snapshotBundleWireSchema = z
  .object({
    schema: z.literal(SNAPSHOT_BODY_SCHEMA),
    state_b64: z.string(),
    covered_ops: z.array(z.tuple([z.string(), z.string()])),
    covered_heads: z.array(z.string()),
    max_lamport: z.string(),
    author_seq: z.array(z.tuple([z.string(), z.number().int().min(0)])),
  })
  .strict();

/** Serialize a bundle to its plaintext bytes (base64 the inner state blob). */
export function serializeSnapshotBundle(bundle: SnapshotBundle): Uint8Array {
  const wire: z.infer<typeof snapshotBundleWireSchema> = {
    schema: SNAPSHOT_BODY_SCHEMA,
    state_b64: toBase64Url(bundle.serializedState),
    covered_ops: bundle.coveredOps.map(([id, lamport]) => [id, lamport]),
    covered_heads: [...bundle.coveredHeads],
    max_lamport: bundle.maxLamport,
    author_seq: bundle.authorSeq.map(([device, seq]) => [device, seq]),
  };
  return utf8(JSON.stringify(wire));
}

/** Parse a bundle from its plaintext bytes (fail-closed via zod). */
export function deserializeSnapshotBundle(bytes: Uint8Array): SnapshotBundle {
  const parsed: unknown = JSON.parse(fromUtf8(bytes));
  const wire = snapshotBundleWireSchema.parse(parsed);
  return {
    serializedState: fromBase64Url(wire.state_b64),
    coveredOps: wire.covered_ops,
    coveredHeads: wire.covered_heads,
    maxLamport: wire.max_lamport,
    authorSeq: wire.author_seq,
  };
}

/** A sealed snapshot body: the ciphertext + AEAD params + its CID (over ciphertext). */
export interface SealedSnapshot {
  readonly cid: string;
  readonly epoch: number;
  readonly nonce: string;
  readonly wrappedObjectKey: string;
  readonly ciphertext: string;
}

export const sealedSnapshotSchema = z
  .object({
    schema: z.literal('licio.private.sealed_snapshot.v1'),
    cid: z.string().min(1).max(256),
    epoch: z.number().int().min(0),
    nonce: z.string(),
    wrapped_object_key: z.string(),
    ciphertext: z.string(),
  })
  .strict();
export type SealedSnapshotWire = z.infer<typeof sealedSnapshotSchema>;

function snapshotBodyAad(roomIdCommitment: Uint8Array, epoch: number): BodyAadInput {
  return {
    envelopeVersion: 1,
    roomIdCommitment,
    roomEpoch: epoch,
    objectType: 'snapshot',
    plaintextSchema: SNAPSHOT_BODY_SCHEMA,
    parentOpIds: [],
    authorDeviceIdBlind: '',
    authorSeq: 0,
    capabilityRootAtSeq: SNAPSHOT_CAP_ROOT,
    chunkIndex: 0,
    chunkTotal: 1,
  };
}

function snapshotWrapAad(roomIdCommitment: Uint8Array, epoch: number): WrapAadInput {
  return { wrappingEpoch: epoch, roomIdCommitment, objectType: 'snapshot' };
}

export interface SealSnapshotParams {
  readonly roomIdCommitment: Uint8Array;
  readonly contentWrapKey: Uint8Array;
  readonly epoch: number;
}

/** AEAD-seal a snapshot bundle under the epoch key + content-address it. */
export async function sealSnapshotBundle(
  bundle: SnapshotBundle,
  params: SealSnapshotParams,
): Promise<SealedSnapshotWire> {
  const plaintext = serializeSnapshotBundle(bundle);
  const policy = selectPaddingPolicy(plaintext.length);
  const sealed = await sealBody(
    plaintext,
    snapshotBodyAad(params.roomIdCommitment, params.epoch),
    policy,
  );
  const wrapped = await wrapKey(
    sealed.objectKey,
    params.contentWrapKey,
    snapshotWrapAad(params.roomIdCommitment, params.epoch),
  );
  const cid = await computePrivateCid(sealed.ciphertext, PRIVATE_CID_CODEC.raw);
  return {
    schema: 'licio.private.sealed_snapshot.v1',
    cid,
    epoch: params.epoch,
    nonce: toBase64Url(sealed.nonce),
    wrapped_object_key: toBase64Url(wrapped),
    ciphertext: toBase64Url(sealed.ciphertext),
  };
}

/**
 * Open a sealed snapshot under the epoch `content_wrap_key`, verifying the
 * ciphertext CID first.  Fails closed (throws `PrivateAeadError` / CID mismatch)
 * if the body was tampered, wrapped under a different epoch, or sealed by a
 * non-member; the caller then quarantines it.
 */
export async function openSnapshotBundle(
  sealed: SealedSnapshotWire,
  params: SealSnapshotParams,
): Promise<SnapshotBundle> {
  const ciphertext = fromBase64Url(sealed.ciphertext);
  if (!(await verifyPrivateCid(ciphertext, sealed.cid, PRIVATE_CID_CODEC.raw))) {
    throw new Error('openSnapshotBundle: ciphertext CID mismatch');
  }
  const objectKey = await unwrapKey(
    fromBase64Url(sealed.wrapped_object_key),
    params.contentWrapKey,
    snapshotWrapAad(params.roomIdCommitment, params.epoch),
  );
  const plaintext = await openBody(
    objectKey,
    fromBase64Url(sealed.nonce),
    ciphertext,
    snapshotBodyAad(params.roomIdCommitment, params.epoch),
  );
  return deserializeSnapshotBundle(plaintext);
}
