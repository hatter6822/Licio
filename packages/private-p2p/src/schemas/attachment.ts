// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.2.3 — `PrivateAttachmentManifestPlainV1` (PRIVATE_SPEC §13.6): the
// decrypted manifest for a chunked, per-chunk-encrypted media object.  Every
// `cid` is over CIPHERTEXT (§9.1); the exact small size is hidden behind a
// padded `byte_size_class` (§13.6/§25.4).  The manifest is itself an encrypted
// object referenced by an `attachment.add` op, so it rides the reducer.
import { z } from 'zod';
import { base64UrlSchema, privateCidSchema, privateIdSchema } from './common.js';

/** One encrypted media chunk: its ciphertext CID + plaintext/ciphertext hashes. */
export const privateEncryptedChunkSchema = z
  .object({
    index: z.number().int().min(0),
    cid: privateCidSchema,
    size: z.number().int().min(1),
    /** Commitment to the chunk PLAINTEXT (verified after local decryption). */
    plaintext_hash_commitment: base64UrlSchema,
    /** Hash of the CIPHERTEXT block (verified on fetch, before decryption). */
    ciphertext_hash: base64UrlSchema,
  })
  .strict();

export const privateAttachmentManifestSchema = z
  .object({
    schema: z.literal('licio.private.attachment_manifest.v1'),
    attachment_id: privateIdSchema,
    room_id: privateIdSchema,
    created_by_member_id: privateIdSchema,
    created_at: z.string().min(1).max(64),

    media_kind: z.enum(['image', 'video', 'audio', 'document', 'caption', 'other']),
    content_type: z.string().min(1).max(255),
    byte_size_exact_encrypted: z.number().int().min(0),
    /** A PADDED size class — hides exact small sizes (a 3 KB and 7 KB image
     *  fall in the same class, §13.6/§25.4). */
    byte_size_class: z.enum(['tiny', 'small', 'medium', 'large', 'huge']),

    encrypted_chunks: z.array(privateEncryptedChunkSchema).min(1).max(65_536),

    accessibility: z
      .object({
        alt_text: z.string().min(1).max(2_000).optional(),
        captions_attachment_id: privateIdSchema.optional(),
      })
      .strict(),

    local_safety: z
      .object({
        metadata_stripped: z.boolean(),
        user_confirmed_right_to_share: z.boolean(),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, ctx) => {
    // Chunk indices must be the contiguous 0..n-1 set, in order (deterministic
    // reassembly; no gaps/dupes that could hide a missing or injected chunk).
    value.encrypted_chunks.forEach((chunk, i) => {
      if (chunk.index !== i) {
        ctx.addIssue({
          code: 'custom',
          path: ['encrypted_chunks', i, 'index'],
          message: `chunk index must be ${i} (contiguous, in order)`,
        });
      }
    });
  });
export type PrivateAttachmentManifest = z.infer<typeof privateAttachmentManifestSchema>;
