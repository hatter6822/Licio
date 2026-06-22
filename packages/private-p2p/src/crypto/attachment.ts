// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.8 — chunked, per-chunk-encrypted media (PRIVATE_SPEC §13.6).  A media blob
// is split into uniform §25.4-padded chunks, each AEAD-sealed under ONE attachment
// object key and bound by `chunk_index`/`chunk_total` in its `body_aad` (so a
// chunk cannot be reordered, dropped, duplicated, or spliced across attachments).
// Every CID is over CIPHERTEXT (§9.1), and the exact size is hidden behind the
// padded chunking + the manifest's coarse `byte_size_class`.  The object key is
// wrapped under the epoch content-wrap key (the manifest object conveys it).
//
// Pure crypto over WebCrypto + the §13.6 schema; `encryptAttachment` →
// `decryptAttachment` round-trips with full verification (ciphertext hash, AEAD
// tag + AAD, and the plaintext commitment), no transport or UI.

import {
  type PrivateAttachmentManifest,
  privateAttachmentManifestSchema,
} from '../schemas/attachment.js';
import {
  aeadOpen,
  aeadSeal,
  type BodyAadInput,
  buildBodyAad,
  OBJECT_KEY_LENGTH,
  PADDING_BUCKET_16K,
  padBody,
  selectPaddingPolicy,
  unpadBody,
  unwrapKey,
  wrapKey,
} from './aead.js';
import { computePrivateCid, PRIVATE_CID_CODEC, verifyPrivateCid } from './cid.js';
import { fromUtf8, randomBytes, sha256, toBase64Url, utf8 } from './runtime.js';

/** The §10.4 `body_aad` version this module pins (must match seal↔open). */
const ATTACHMENT_AAD_VERSION = 1;
/** The attachment manifest's plaintext-schema tag, bound into every `body_aad`. */
const ATTACHMENT_SCHEMA = 'licio.private.attachment_manifest.v1';
/** Per-chunk plaintext size — comfortably under the 16 KiB §25.4 bucket (which
 *  also carries a length prefix), so every chunk pads to ONE uniform ciphertext
 *  length and the wire reveals only the chunk COUNT, never a chunk's true size. */
export const ATTACHMENT_CHUNK_PLAINTEXT_SIZE = PADDING_BUCKET_16K - 384;

/** The coarse §13.6 size class (hides the exact plaintext size). */
export function classifySize(byteLength: number): PrivateAttachmentManifest['byte_size_class'] {
  if (byteLength < 16 * 1024) return 'tiny';
  if (byteLength < 256 * 1024) return 'small';
  if (byteLength < 4 * 1024 * 1024) return 'medium';
  if (byteLength < 64 * 1024 * 1024) return 'large';
  return 'huge';
}

/** Build the `body_aad` for one chunk (or the manifest body at index 0/total 1),
 *  binding it to the room, the attachment, and its position. */
function attachmentAad(
  roomIdCommitment: Uint8Array,
  roomEpoch: number,
  attachmentId: string,
  objectType: 'media_chunk' | 'attachment_manifest',
  chunkIndex: number,
  chunkTotal: number,
): BodyAadInput {
  return {
    envelopeVersion: ATTACHMENT_AAD_VERSION,
    roomIdCommitment,
    roomEpoch,
    objectType,
    plaintextSchema: ATTACHMENT_SCHEMA,
    parentOpIds: [attachmentId],
    authorDeviceIdBlind: '',
    authorSeq: 0,
    capabilityRootAtSeq: new Uint8Array(0),
    chunkIndex,
    chunkTotal,
  };
}

/** Parameters describing the attachment being encrypted. */
export interface EncryptAttachmentParams {
  readonly attachmentId: string;
  readonly roomId: string;
  readonly roomIdCommitment: Uint8Array;
  readonly roomEpoch: number;
  readonly mediaKind: PrivateAttachmentManifest['media_kind'];
  readonly contentType: string;
  readonly createdByMemberId: string;
  readonly createdAt: string;
  /** The epoch content-wrap key (wraps the attachment object key). */
  readonly contentWrapKey: Uint8Array;
  readonly altText?: string;
  /** Caller asserts the upload was metadata-stripped + the user confirmed rights. */
  readonly metadataStripped: boolean;
  readonly userConfirmedRightToShare: boolean;
}

/** The output of `encryptAttachment`: the plaintext manifest + everything the
 *  caller persists/distributes (sealed manifest object, chunk blocks, wrapped key). */
export interface EncryptedAttachment {
  readonly manifest: PrivateAttachmentManifest;
  /** The CID (over ciphertext) of the sealed manifest object — the value an
   *  `attachment.add` op's `manifest_cid` carries. */
  readonly manifestCid: string;
  /** The sealed manifest object bytes (store at `manifestCid`). */
  readonly sealedManifest: Uint8Array;
  /** Sealed chunk blocks keyed by CID (each verifiable + fetchable by CID). */
  readonly chunks: ReadonlyMap<string, Uint8Array>;
  /** The attachment object key (32 bytes) — chunks + manifest seal under it. */
  readonly objectKey: Uint8Array;
  /** The object key wrapped under `contentWrapKey` (conveys it to members). */
  readonly wrappedObjectKey: Uint8Array;
}

/**
 * Encrypt a media blob into a §13.6 attachment: uniform padded, AEAD-sealed chunks
 * (CIDs over ciphertext) + a sealed manifest, all under one wrapped object key.
 */
export async function encryptAttachment(
  plaintext: Uint8Array,
  params: EncryptAttachmentParams,
): Promise<EncryptedAttachment> {
  const objectKey = randomBytes(OBJECT_KEY_LENGTH);
  const totalChunks = Math.max(1, Math.ceil(plaintext.length / ATTACHMENT_CHUNK_PLAINTEXT_SIZE));
  const chunks = new Map<string, Uint8Array>();
  const encryptedChunks: PrivateAttachmentManifest['encrypted_chunks'][number][] = [];

  for (let i = 0; i < totalChunks; i++) {
    const slice = plaintext.subarray(
      i * ATTACHMENT_CHUNK_PLAINTEXT_SIZE,
      (i + 1) * ATTACHMENT_CHUNK_PLAINTEXT_SIZE,
    );
    const padded = padBody(slice, 'small-op-16k');
    const aad = buildBodyAad(
      attachmentAad(
        params.roomIdCommitment,
        params.roomEpoch,
        params.attachmentId,
        'media_chunk',
        i,
        totalChunks,
      ),
    );
    const sealed = await aeadSeal(objectKey, padded, aad);
    const cid = await computePrivateCid(sealed, PRIVATE_CID_CODEC.raw);
    chunks.set(cid, sealed);
    encryptedChunks.push({
      index: i,
      cid,
      size: sealed.length,
      plaintext_hash_commitment: toBase64Url(await sha256(slice)),
      ciphertext_hash: toBase64Url(await sha256(sealed)),
    });
  }

  let byteSizeExactEncrypted = 0;
  for (const block of chunks.values()) byteSizeExactEncrypted += block.length;

  const manifest = privateAttachmentManifestSchema.parse({
    schema: ATTACHMENT_SCHEMA,
    attachment_id: params.attachmentId,
    room_id: params.roomId,
    created_by_member_id: params.createdByMemberId,
    created_at: params.createdAt,
    media_kind: params.mediaKind,
    content_type: params.contentType,
    byte_size_exact_encrypted: byteSizeExactEncrypted,
    byte_size_class: classifySize(plaintext.length),
    encrypted_chunks: encryptedChunks,
    accessibility: params.altText === undefined ? {} : { alt_text: params.altText },
    local_safety: {
      metadata_stripped: params.metadataStripped,
      user_confirmed_right_to_share: params.userConfirmedRightToShare,
    },
  } satisfies PrivateAttachmentManifest);

  // Seal the manifest object under the SAME object key (members who unwrap the key
  // can open both the manifest and its chunks).
  const manifestBytes = utf8(JSON.stringify(manifest));
  const manifestAadInput = attachmentAad(
    params.roomIdCommitment,
    params.roomEpoch,
    params.attachmentId,
    'attachment_manifest',
    0,
    1,
  );
  const sealedManifest = await aeadSeal(
    objectKey,
    padBody(manifestBytes, selectPaddingPolicy(manifestBytes.length)),
    buildBodyAad(manifestAadInput),
  );
  const manifestCid = await computePrivateCid(sealedManifest, PRIVATE_CID_CODEC.raw);
  const wrappedObjectKey = await wrapKey(objectKey, params.contentWrapKey, {
    wrappingEpoch: params.roomEpoch,
    roomIdCommitment: params.roomIdCommitment,
    objectType: 'attachment_manifest',
  });

  return { manifest, manifestCid, sealedManifest, chunks, objectKey, wrappedObjectKey };
}

/** The room context needed to rebuild a chunk/manifest `body_aad` at decrypt. */
export interface AttachmentDecryptContext {
  readonly roomIdCommitment: Uint8Array;
  readonly roomEpoch: number;
  /** The epoch content-wrap key — if given with `wrappedObjectKey`, the object key
   *  is unwrapped (otherwise pass `objectKey` directly). */
  readonly contentWrapKey?: Uint8Array;
}

/** Recover the attachment object key, unwrapping it if a wrapped key + content-wrap
 *  key are supplied. */
async function resolveObjectKey(
  objectKey: Uint8Array | undefined,
  wrappedObjectKey: Uint8Array | undefined,
  ctx: AttachmentDecryptContext,
): Promise<Uint8Array> {
  if (objectKey) return objectKey;
  if (wrappedObjectKey && ctx.contentWrapKey) {
    return unwrapKey(wrappedObjectKey, ctx.contentWrapKey, {
      wrappingEpoch: ctx.roomEpoch,
      roomIdCommitment: ctx.roomIdCommitment,
      objectType: 'attachment_manifest',
    });
  }
  throw new Error('decryptAttachment: provide objectKey or (wrappedObjectKey + contentWrapKey)');
}

/** Open a sealed manifest object back into the validated plaintext manifest. */
export async function openAttachmentManifest(
  sealedManifest: Uint8Array,
  attachmentId: string,
  ctx: AttachmentDecryptContext,
  keys: { objectKey?: Uint8Array; wrappedObjectKey?: Uint8Array },
): Promise<PrivateAttachmentManifest> {
  const objectKey = await resolveObjectKey(keys.objectKey, keys.wrappedObjectKey, ctx);
  const padded = await aeadOpen(
    objectKey,
    sealedManifest,
    buildBodyAad(
      attachmentAad(ctx.roomIdCommitment, ctx.roomEpoch, attachmentId, 'attachment_manifest', 0, 1),
    ),
  );
  const json: unknown = JSON.parse(fromUtf8(unpadBody(padded)));
  return privateAttachmentManifestSchema.parse(json);
}

/**
 * Decrypt + reassemble a §13.6 attachment from its manifest + sealed chunk blocks.
 * For every chunk it verifies the ciphertext hash (before decryption), opens the
 * AEAD (tag + AAD bind the position), and verifies the plaintext commitment —
 * failing closed on any tamper, missing chunk, or out-of-order block.
 */
export async function decryptAttachment(
  manifest: PrivateAttachmentManifest,
  chunksByCid: ReadonlyMap<string, Uint8Array>,
  ctx: AttachmentDecryptContext,
  keys: { objectKey?: Uint8Array; wrappedObjectKey?: Uint8Array },
): Promise<Uint8Array> {
  const objectKey = await resolveObjectKey(keys.objectKey, keys.wrappedObjectKey, ctx);
  const total = manifest.encrypted_chunks.length;
  const parts: Uint8Array[] = [];

  for (const chunk of manifest.encrypted_chunks) {
    const sealed = chunksByCid.get(chunk.cid);
    if (!sealed) throw new Error(`decryptAttachment: missing chunk ${chunk.index} (${chunk.cid})`);
    // Verify the ciphertext CID + hash BEFORE decrypting (cheap integrity gate).
    if (!(await verifyPrivateCid(sealed, chunk.cid, PRIVATE_CID_CODEC.raw))) {
      throw new Error(`decryptAttachment: chunk ${chunk.index} CID mismatch`);
    }
    if (toBase64Url(await sha256(sealed)) !== chunk.ciphertext_hash) {
      throw new Error(`decryptAttachment: chunk ${chunk.index} ciphertext-hash mismatch`);
    }
    const padded = await aeadOpen(
      objectKey,
      sealed,
      buildBodyAad(
        attachmentAad(
          ctx.roomIdCommitment,
          ctx.roomEpoch,
          manifest.attachment_id,
          'media_chunk',
          chunk.index,
          total,
        ),
      ),
    );
    const plain = unpadBody(padded);
    if (toBase64Url(await sha256(plain)) !== chunk.plaintext_hash_commitment) {
      throw new Error(`decryptAttachment: chunk ${chunk.index} plaintext-commitment mismatch`);
    }
    parts.push(plain);
  }

  let length = 0;
  for (const part of parts) length += part.length;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
