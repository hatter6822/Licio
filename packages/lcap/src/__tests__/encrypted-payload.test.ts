// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.16.1 — the LCAP-side encrypted-payload carrier (OFFLINE_SPEC §28.2).
// These tests pin the doctrine that LCAP carries ciphertext + OPAQUE hints
// only: it never decrypts, the descriptor is closed against plaintext / key /
// op-head / real-room-id egress, and a group-keyed suite forbids the
// plaintext-equality hints (§10.6).

import { describe, expect, it } from 'vitest';
import {
  buildEncryptedPayloadBlock,
  ENCRYPTED_PAYLOAD_MEDIA_TYPE,
  verifyEncryptedPayloadBlock,
} from '../block/index.js';
import { encode } from '../cbor/encode.js';
import { cidFor } from '../cid/index.js';
import { decodeWithSchema, encodeWithSchema, plainToLdc } from '../schemas/codec.js';
import {
  type EncryptedPayloadDescriptorV2,
  encryptedPayloadDescriptorV2Schema,
} from '../schemas/records.js';

function bytes(n: number, seed = 7): Uint8Array {
  const out = new Uint8Array(n);
  let x = seed >>> 0;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    out[i] = x & 0xff;
  }
  return out;
}

const baseHints = {
  suite: 'MLS-derived-AEAD' as const,
  keyEpochId: 'epoch:42',
  nonce: bytes(12, 1),
  aadContext: bytes(32, 2), // a SHA-256-sized commitment
};

describe('WS-R.16.1 encrypted-payload carrier — build/verify', () => {
  it('mints an encrypted_payload block + descriptor over opaque ciphertext', async () => {
    const ciphertext = bytes(256, 3);
    const { block, descriptor } = await buildEncryptedPayloadBlock(ciphertext, baseHints);

    expect(block.role).toBe('encrypted_payload');
    expect(block.media_type).toBe(ENCRYPTED_PAYLOAD_MEDIA_TYPE);
    expect(block.size_bytes).toBe(ciphertext.length);
    // The block CID is over the CIPHERTEXT (§28.1: no plaintext CID ever exists).
    expect(block.block_cid).toBe(await cidFor('block', ciphertext));
    expect(descriptor.encryption_version).toBe(2);
    expect(descriptor.ciphertext_block_cid).toBe(block.block_cid);
    expect(descriptor.key_epoch_id).toBe('epoch:42');
  });

  it('verifies a faithful carrier and re-hashes (no decrypt)', async () => {
    const ciphertext = bytes(512, 4);
    const { block, descriptor } = await buildEncryptedPayloadBlock(ciphertext, baseHints);
    expect(await verifyEncryptedPayloadBlock(descriptor, block, ciphertext)).toEqual({ ok: true });
  });

  it('fails closed on tampered ciphertext (CID re-hash mismatch)', async () => {
    const ciphertext = bytes(64, 5);
    const { block, descriptor } = await buildEncryptedPayloadBlock(ciphertext, baseHints);
    const tampered = Uint8Array.from(ciphertext);
    tampered[0] = (ciphertext[0] ?? 0) ^ 0xff;
    const v = await verifyEncryptedPayloadBlock(descriptor, block, tampered);
    expect(v.ok).toBe(false);
  });

  it('fails closed when the block plays the wrong role', async () => {
    const ciphertext = bytes(64, 6);
    const { block, descriptor } = await buildEncryptedPayloadBlock(ciphertext, baseHints);
    const v = await verifyEncryptedPayloadBlock(
      descriptor,
      { ...block, role: 'image' },
      ciphertext,
    );
    expect(v).toEqual({ ok: false, status: 'wrong_role' });
  });

  it('fails closed when the descriptor references a different block', async () => {
    const ciphertext = bytes(64, 7);
    const other = bytes(64, 99);
    const { block, descriptor } = await buildEncryptedPayloadBlock(ciphertext, baseHints);
    const v = await verifyEncryptedPayloadBlock(
      { ...descriptor, ciphertext_block_cid: await cidFor('block', other) },
      block,
      ciphertext,
    );
    expect(v).toEqual({ ok: false, status: 'cid_mismatch' });
  });
});

describe('WS-R.16.1 encrypted-payload descriptor — closed against egress', () => {
  it('rejects a group-keyed suite carrying a plaintext digest (§10.6)', async () => {
    const ciphertext = bytes(64, 8);
    await expect(
      buildEncryptedPayloadBlock(ciphertext, {
        ...baseHints,
        plaintextSha256: bytes(32, 9),
      }),
    ).rejects.toThrow();
  });

  it('rejects a group-keyed suite carrying a plaintext size (§10.6)', async () => {
    const ciphertext = bytes(64, 10);
    await expect(
      buildEncryptedPayloadBlock(ciphertext, { ...baseHints, plaintextSize: 1234 }),
    ).rejects.toThrow();
  });

  it('permits plaintext hints ONLY for a non-group-keyed suite', async () => {
    const ciphertext = bytes(64, 11);
    const { descriptor } = await buildEncryptedPayloadBlock(ciphertext, {
      ...baseHints,
      suite: 'AES-256-GCM',
      plaintextSha256: bytes(32, 12),
      plaintextSize: 64,
    });
    expect(descriptor.suite).toBe('AES-256-GCM');
    expect(descriptor.plaintext_size).toBe(64);
  });

  it('structurally rejects an unknown key (room id / op-head / plaintext)', () => {
    const good = {
      encryption_version: 2 as const,
      suite: 'MLS-derived-AEAD' as const,
      key_epoch_id: 'e1',
      nonce: bytes(12, 1),
      aad_context: bytes(32, 2),
      ciphertext_block_cid: 'irrelevant', // replaced below
    };
    for (const forbidden of [
      'room_id',
      'parent_op_ids',
      'plaintext',
      'op_head',
      'private_room_id',
    ]) {
      const candidate = { ...good, [forbidden]: 'x' };
      expect(encryptedPayloadDescriptorV2Schema.safeParse(candidate).success).toBe(false);
    }
  });

  it('rejects an over-long aad_context (must be a commitment, not raw AAD inputs)', async () => {
    const ciphertext = bytes(64, 13);
    await expect(
      buildEncryptedPayloadBlock(ciphertext, { ...baseHints, aadContext: bytes(128, 14) }),
    ).rejects.toThrow();
  });

  it('rejects an over-long nonce and an over-long key_epoch_id', async () => {
    const ciphertext = bytes(64, 15);
    await expect(
      buildEncryptedPayloadBlock(ciphertext, { ...baseHints, nonce: bytes(64, 16) }),
    ).rejects.toThrow();
    await expect(
      buildEncryptedPayloadBlock(ciphertext, { ...baseHints, keyEpochId: 'x'.repeat(257) }),
    ).rejects.toThrow();
  });
});

describe('WS-R.16.1 encrypted-payload descriptor — deterministic LDC carriage', () => {
  it('round-trips byte-identically through the LDC codec', async () => {
    const ciphertext = bytes(200, 17);
    const { descriptor } = await buildEncryptedPayloadBlock(ciphertext, baseHints);
    const encoded = encodeWithSchema(encryptedPayloadDescriptorV2Schema, descriptor);
    const decoded: EncryptedPayloadDescriptorV2 = decodeWithSchema(
      encryptedPayloadDescriptorV2Schema,
      encoded,
    );
    expect(decoded.ciphertext_block_cid).toBe(descriptor.ciphertext_block_cid);
    expect(decoded.key_epoch_id).toBe(descriptor.key_epoch_id);
    // Re-encoding the decoded value is byte-identical (determinism).
    const reEncoded = encodeWithSchema(encryptedPayloadDescriptorV2Schema, decoded);
    expect(Array.from(reEncoded)).toEqual(Array.from(encoded));
  });

  it('the decode path re-applies the §10.6 group-keyed restriction', async () => {
    // A hostile peer hand-crafts bytes for an MLS-derived descriptor that
    // smuggles a plaintext digest, bypassing the builder.  The decoder MUST
    // reject it (the superRefine runs on decode too).
    const ciphertext = bytes(48, 18);
    const smuggled = {
      encryption_version: 2,
      suite: 'MLS-derived-AEAD',
      key_epoch_id: 'e1',
      nonce: bytes(12, 1),
      aad_context: bytes(32, 2),
      ciphertext_block_cid: await cidFor('block', ciphertext),
      plaintext_sha256: bytes(32, 19),
    };
    const rawBytes = encode(plainToLdc(smuggled));
    expect(() => decodeWithSchema(encryptedPayloadDescriptorV2Schema, rawBytes)).toThrow();
  });
});
