// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.8 — §13.6 chunked media: encrypt→decrypt round-trip + the integrity and
// size-privacy properties (uniform chunk ciphertext, AAD-bound position, full
// verification on decrypt, fail-closed on tamper/missing/cross-attachment).
import { describe, expect, it } from 'vitest';
import {
  ATTACHMENT_CHUNK_PLAINTEXT_SIZE,
  classifySize,
  decryptAttachment,
  encryptAttachment,
  openAttachmentManifest,
} from '../crypto/attachment.js';
import { fromBase64Url, randomBytes, toBase64Url } from '../crypto/runtime.js';
import { attachmentAddOpSchema } from '../schemas/ops.js';

const ROOM_COMMIT = new Uint8Array(32).fill(7);
const WRAP_KEY = new Uint8Array(32).fill(9);

function params(overrides: Record<string, unknown> = {}) {
  return {
    attachmentId: 'att-1',
    roomId: 'r',
    roomIdCommitment: ROOM_COMMIT,
    roomEpoch: 0,
    mediaKind: 'image' as const,
    contentType: 'image/png',
    createdByMemberId: 'alice',
    createdAt: '2026-06-22T00:00:00Z',
    contentWrapKey: WRAP_KEY,
    metadataStripped: true,
    userConfirmedRightToShare: true,
    ...overrides,
  };
}

const ctx = { roomIdCommitment: ROOM_COMMIT, roomEpoch: 0 };

describe('encryptAttachment / decryptAttachment (§13.6 media)', () => {
  it('round-trips a multi-chunk blob byte-for-byte', async () => {
    const data = randomBytes(ATTACHMENT_CHUNK_PLAINTEXT_SIZE * 2 + 1234);
    const enc = await encryptAttachment(data, params());
    expect(enc.manifest.encrypted_chunks).toHaveLength(3);
    expect(enc.chunks.size).toBe(3);
    expect(enc.manifest.media_kind).toBe('image');

    const out = await decryptAttachment(enc.manifest, enc.chunks, ctx, {
      objectKey: enc.objectKey,
    });
    expect(out).toStrictEqual(data);
  });

  it('seals every chunk to one uniform ciphertext length (size privacy)', async () => {
    const enc = await encryptAttachment(
      randomBytes(ATTACHMENT_CHUNK_PLAINTEXT_SIZE * 2 + 5),
      params(),
    );
    const sizes = new Set([...enc.chunks.values()].map((block) => block.length));
    expect(sizes.size).toBe(1);
  });

  it('decrypts via the wrapped object key + content-wrap key', async () => {
    const data = randomBytes(5000);
    const enc = await encryptAttachment(data, params());
    const out = await decryptAttachment(
      enc.manifest,
      enc.chunks,
      { ...ctx, contentWrapKey: WRAP_KEY },
      { wrappedObjectKey: enc.wrappedObjectKey },
    );
    expect(out).toStrictEqual(data);
  });

  it('the attachment.add op CARRIES the wrapped key — a peer opens the manifest from the op alone', async () => {
    const enc = await encryptAttachment(randomBytes(3000), params());
    // The op a member distributes: the manifest CID AND the wrapped object key.
    const op = attachmentAddOpSchema.parse({
      type: 'attachment.add',
      attachment_id: 'att-1',
      manifest_cid: enc.manifestCid,
      wrapped_object_key: toBase64Url(enc.wrappedObjectKey),
    });
    // A PEER (with only the op + its epoch content-wrap key, no out-of-band key)
    // reconstructs the object key from the op and opens the sealed manifest.
    const opened = await openAttachmentManifest(
      enc.sealedManifest,
      'att-1',
      {
        ...ctx,
        contentWrapKey: WRAP_KEY,
      },
      { wrappedObjectKey: fromBase64Url(op.wrapped_object_key) },
    );
    expect(opened.attachment_id).toBe('att-1');
  });

  it('opens the sealed manifest object back to the validated manifest', async () => {
    const enc = await encryptAttachment(randomBytes(3000), params());
    const opened = await openAttachmentManifest(enc.sealedManifest, 'att-1', ctx, {
      objectKey: enc.objectKey,
    });
    expect(opened.attachment_id).toBe('att-1');
    expect(opened.encrypted_chunks).toHaveLength(enc.manifest.encrypted_chunks.length);
  });

  it('detects a tampered chunk', async () => {
    const enc = await encryptAttachment(randomBytes(3000), params());
    const entry = [...enc.chunks.entries()][0];
    if (!entry) throw new Error('expected a chunk');
    const [cid, block] = entry;
    const corrupt = block.slice();
    corrupt[corrupt.length - 1] = (corrupt[corrupt.length - 1] ?? 0) ^ 0xff;
    const tampered = new Map(enc.chunks);
    tampered.set(cid, corrupt);
    await expect(
      decryptAttachment(enc.manifest, tampered, ctx, { objectKey: enc.objectKey }),
    ).rejects.toThrow();
  });

  it('rejects a missing chunk', async () => {
    const enc = await encryptAttachment(
      randomBytes(ATTACHMENT_CHUNK_PLAINTEXT_SIZE + 10),
      params(),
    );
    const incomplete = new Map([...enc.chunks.entries()].slice(0, 1));
    await expect(
      decryptAttachment(enc.manifest, incomplete, ctx, { objectKey: enc.objectKey }),
    ).rejects.toThrow(/missing chunk/);
  });

  it('a chunk cannot be opened under a different attachment id (AAD binds it)', async () => {
    const enc = await encryptAttachment(randomBytes(3000), params({ attachmentId: 'att-A' }));
    const forged = { ...enc.manifest, attachment_id: 'att-B' };
    await expect(
      decryptAttachment(forged, enc.chunks, ctx, { objectKey: enc.objectKey }),
    ).rejects.toThrow();
  });

  it('handles an empty blob (one padded chunk)', async () => {
    const enc = await encryptAttachment(new Uint8Array(0), params());
    expect(enc.manifest.encrypted_chunks).toHaveLength(1);
    expect(enc.manifest.byte_size_class).toBe('tiny');
    const out = await decryptAttachment(enc.manifest, enc.chunks, ctx, {
      objectKey: enc.objectKey,
    });
    expect(out).toStrictEqual(new Uint8Array(0));
  });

  it('classifies the §13.6 size buckets at their boundaries', () => {
    expect(classifySize(0)).toBe('tiny');
    expect(classifySize(16 * 1024 - 1)).toBe('tiny');
    expect(classifySize(16 * 1024)).toBe('small');
    expect(classifySize(256 * 1024)).toBe('medium');
    expect(classifySize(4 * 1024 * 1024)).toBe('large');
    expect(classifySize(64 * 1024 * 1024)).toBe('huge');
  });

  it('throws when neither an object key nor a wrapped key is supplied', async () => {
    const enc = await encryptAttachment(randomBytes(2000), params());
    await expect(decryptAttachment(enc.manifest, enc.chunks, ctx, {})).rejects.toThrow(
      /objectKey or/,
    );
  });
});
