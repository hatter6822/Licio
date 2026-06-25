// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.6.5 — offline encrypted-archive (CAR) exchange (PRIVATE_SPEC §15.9).
//
// Export selected ENCRYPTED envelopes into a single self-contained container
// (share via USB / AirDrop / manual), then import → verify → reduce on another
// device.  The container is CIPHERTEXT-ONLY (a `PrivateEncryptedEnvelope` has no
// plaintext field by construction) and confers NO trust: `importBlockArchive`
// re-runs the §14.2 stage-1 validation (`openOp`) on EVERY envelope before any
// op is returned for the structural pass + reduce, so a tampered or foreign
// envelope is quarantined exactly as a wire-fetched block would be.
//
// The optional WS-R `.licio-bundle` carriage (§15.9) SHIPS cross-plane in
// `apps/web/src/lcap/cross-plane-bridge.ts` (it imports BOTH planes); `@licio/private-p2p`
// never imports `@licio/lcap`, so this package ships the self-contained
// ciphertext container + the re-validating import that the bridge reuses.  The
// third UI export — the user's PLAINTEXT "decrypted personal archive" — is a
// WS-S.7/8 concern and is intentionally NOT a kind of this ciphertext container.

import { z } from 'zod';
import { type CanonicalDecodeLimits, decodeCanonical } from '../crypto/canonical.js';
import { canonicalizeRecord } from '../crypto/record-encoding.js';
import { type SealedSnapshotWire, sealedSnapshotSchema } from '../reducer/snapshot-seal.js';
import { type OpIntakeContext, type OpIntakeRejection, openOp } from '../reducer/validate-op.js';
import { base64UrlSchema, timeBucketSchema } from '../schemas/common.js';
import {
  type PrivateEncryptedEnvelope,
  privateEncryptedEnvelopeSchema,
} from '../schemas/envelope.js';
import type { PrivateRoomOp } from '../schemas/ops.js';

/**
 * The §15.9 ciphertext-only container kinds.  `encrypted_member_backup` is a
 * member's own re-importable backup; `voluntary_report` is the ciphertext a
 * member chooses to share for a report.  Both carry ENCRYPTED envelopes only —
 * the "decrypted personal archive" UI export (plaintext) is never this container.
 */
export const PRIVATE_ARCHIVE_KINDS = ['encrypted_member_backup', 'voluntary_report'] as const;
export type PrivateArchiveKind = (typeof PRIVATE_ARCHIVE_KINDS)[number];

/** The eager-archive envelope cap (very large exports use the streaming
 *  `.licio-bundle` carrier — the cross-plane `apps/web/src/lcap/cross-plane-bridge.ts`). */
export const PRIVATE_ARCHIVE_MAX_ENVELOPES = 4_096;

/** §15.9 — a self-contained, re-importable archive of encrypted envelopes for ONE
 *  room.  Strict + ciphertext-only (every entry is a `PrivateEncryptedEnvelope`). */
export const privateBlockArchiveSchema = z
  .object({
    schema: z.literal('licio.private.block_archive.v1'),
    kind: z.enum(PRIVATE_ARCHIVE_KINDS),
    room_id_hash: base64UrlSchema,
    created_at_bucket: timeBucketSchema,
    envelopes: z.array(privateEncryptedEnvelopeSchema).min(1).max(PRIVATE_ARCHIVE_MAX_ENVELOPES),
    /** §14.5 — for a COMPACTED room, the sealed snapshot body the in-band
     *  `snapshot.commit` (among `envelopes`) references, so an importer that lacks
     *  the pruned ops can bootstrap (verify-before-use against the commit). */
    sealed_snapshot: sealedSnapshotSchema.optional(),
  })
  .strict();
export type PrivateBlockArchive = z.infer<typeof privateBlockArchiveSchema>;

export interface BuildArchiveParams {
  readonly kind: PrivateArchiveKind;
  readonly roomIdHash: string;
  readonly createdAtBucket: string;
  readonly envelopes: readonly PrivateEncryptedEnvelope[];
  readonly sealedSnapshot?: SealedSnapshotWire;
}

/**
 * Build a ciphertext-only archive for ONE room.  Rejects an envelope whose
 * `room_id_hash` differs from the archive's (an archive is per-room) — a mixed-
 * room container could confuse import routing.
 */
export function buildBlockArchive(params: BuildArchiveParams): PrivateBlockArchive {
  for (const envelope of params.envelopes) {
    if (envelope.room_id_hash !== params.roomIdHash) {
      throw new Error('buildBlockArchive: envelope room_id_hash does not match the archive room');
    }
  }
  return privateBlockArchiveSchema.parse({
    schema: 'licio.private.block_archive.v1',
    kind: params.kind,
    room_id_hash: params.roomIdHash,
    created_at_bucket: params.createdAtBucket,
    envelopes: params.envelopes,
    ...(params.sealedSnapshot ? { sealed_snapshot: params.sealedSnapshot } : {}),
  });
}

/** Canonical-encode an archive to its single byte representation (for sharing). */
export function encodeBlockArchive(archive: PrivateBlockArchive): Uint8Array {
  return canonicalizeRecord(privateBlockArchiveSchema.parse(archive));
}

/** §27 import caps for an eager archive decode (bounded against a decode bomb). */
export const ARCHIVE_DECODE_LIMITS: CanonicalDecodeLimits = {
  maxDepth: 32,
  maxBytes: 67_108_864, // 64 MiB
  maxItems: 524_288,
};

/** Decode + strictly validate an archive's bytes under the §27 caps. */
export function decodeBlockArchive(bytes: Uint8Array): PrivateBlockArchive {
  return privateBlockArchiveSchema.parse(decodeCanonical(bytes, ARCHIVE_DECODE_LIMITS));
}

export interface ImportedArchiveOp {
  readonly index: number;
  readonly op: PrivateRoomOp;
}

export interface RejectedArchiveEnvelope {
  readonly index: number;
  readonly reason: OpIntakeRejection;
}

export interface ImportArchiveResult {
  /** The room the archive declared (the importer confirms it expected this room). */
  readonly roomIdHash: string;
  readonly kind: PrivateArchiveKind;
  /** Ops that passed §14.2 stage-1 re-validation — ready for the structural pass
   *  + reduce.  NOTHING here is trusted beyond stage-1 yet (the caller runs
   *  validateStructure + reduceRoom, the §14.2 stage-2/3 + fold). */
  readonly accepted: ImportedArchiveOp[];
  /** Envelopes quarantined at stage-1 (a tampered/foreign block confers nothing). */
  readonly rejected: RejectedArchiveEnvelope[];
}

/**
 * Import an archive: decode under caps, then re-run the §14.2 stage-1 validation
 * (`openOp`) on EVERY envelope.  The container confers no trust — each envelope
 * must independently verify (signature → AEAD-open → schema → metadata match)
 * under the importer's own epoch keys + device registry.  Returns the stage-1-
 * accepted ops (for the caller's structural pass + reduce) and the quarantined
 * envelopes with their typed reasons.
 */
export async function importBlockArchive(
  bytes: Uint8Array,
  ctx: OpIntakeContext,
): Promise<ImportArchiveResult> {
  const archive = decodeBlockArchive(bytes);
  const accepted: ImportedArchiveOp[] = [];
  const rejected: RejectedArchiveEnvelope[] = [];
  for (let index = 0; index < archive.envelopes.length; index++) {
    // biome-ignore lint/style/noNonNullAssertion: index is bounded by the loop.
    const envelope = archive.envelopes[index]!;
    const result = await openOp(envelope, ctx);
    if (result.ok) {
      accepted.push({ index, op: result.op });
    } else {
      rejected.push({ index, reason: result.reason });
    }
  }
  return { roomIdHash: archive.room_id_hash, kind: archive.kind, accepted, rejected };
}
