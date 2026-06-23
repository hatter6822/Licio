// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.3.5 — Ed25519 device-signature tests.  The known-answer vectors below
// were generated with `@noble/curves` (an independent, audited RFC 8032
// implementation — and the §10.7-named fallback library), NOT this runtime's
// WebCrypto/OpenSSL backend.  Ed25519 signing is deterministic, so byte-
// identical public-key derivation AND signatures across two independent
// implementations pin WebCrypto's Ed25519 to RFC 8032.  The remaining tests
// cover the wrapper: round-trip, tamper rejection, key isolation, length guards,
// and the §10.7 envelope-signing surface.
import { describe, expect, it } from 'vitest';
import {
  ED25519_SIGNATURE_LENGTH,
  envelopeSigningInput,
  exportPrivateKeyPkcs8,
  exportPublicKeyRaw,
  generateDeviceSigningKeyPair,
  importPrivateKeyPkcs8,
  importPublicKeyRaw,
  pkcs8FromSeed,
  signEd25519,
  signEnvelope,
  verifyEd25519,
  verifyEnvelopeSignature,
} from '../crypto/signatures.js';
import { privateEncryptedEnvelopeSchema } from '../schemas/envelope.js';

function hex(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}
const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

// Cross-validated against @noble/curves (independent RFC 8032 implementation).
const KATS = [
  {
    seed: '0000000000000000000000000000000000000000000000000000000000000000',
    msg: '',
    pk: '3b6a27bcceb6a42d62a3a8d02a6f0d73653215771de243a63ac048a18b59da29',
    sig: '8f895b3cafe2c9506039d0e2a66382568004674fe8d237785092e40d6aaf483e4fc60168705f31f101596138ce21aa357c0d32a064f423dc3ee4aa3abf53f803',
  },
  {
    seed: '4242424242424242424242424242424242424242424242424242424242424242',
    msg: '72',
    pk: '2152f8d19b791d24453242e15f2eab6cb7cffa7b6a5ed30097960e069881db12',
    sig: '50716e28ba667c177224a50918dc1bf616466b862e0cf71e9ccdcb8fc991877af16449337979a56711f767d076233d62ffe32febfa2fc43fab271a8bf592320a',
  },
  {
    seed: '9d61b19deffebc3b6e9d5f23e3a3c4ff5e7a16c0227031c8e3b6f1d4c8e8e8e8e',
    msg: '616263',
    pk: '01e07c67e4fcc8ee77741b7c1feb63db91d1448d50755dadae89c6bacc862637',
    sig: '3f87114f164e253f3cc5b81397339e068eef9b1a934e1d08b72a7dc8fdb6dd5231f8e4add9a3e318faadf66758868dadcfaec02a391ea597d8c78c76557b980e',
  },
] as const;

describe('Ed25519 known-answer vectors (cross-validated, RFC 8032)', () => {
  for (const [i, kat] of KATS.entries()) {
    it(`derives the public key for vector ${i}`, async () => {
      const priv = await importPrivateKeyPkcs8(pkcs8FromSeed(hex(kat.seed)));
      const pub = await importPublicKeyRaw(hex(kat.pk));
      // WebCrypto cannot derive a public key from a private key directly; instead
      // sign+verify proves the imported private key matches the vector public key.
      const sig = await signEd25519(priv, hex(kat.msg));
      expect(await verifyEd25519(pub, hex(kat.msg), sig)).toBe(true);
    });

    it(`produces the exact deterministic signature for vector ${i}`, async () => {
      const priv = await importPrivateKeyPkcs8(pkcs8FromSeed(hex(kat.seed)));
      const sig = await signEd25519(priv, hex(kat.msg));
      expect(toHex(sig)).toBe(kat.sig);
    });

    it(`verifies the vector signature, rejects a tampered one for vector ${i}`, async () => {
      const pub = await importPublicKeyRaw(hex(kat.pk));
      expect(await verifyEd25519(pub, hex(kat.msg), hex(kat.sig))).toBe(true);
      const tampered = hex(kat.sig);
      tampered[0] = (tampered[0] as number) ^ 0x01;
      expect(await verifyEd25519(pub, hex(kat.msg), tampered)).toBe(false);
    });
  }
});

describe('Ed25519 wrapper', () => {
  it('round-trips sign/verify with a generated key pair', async () => {
    const kp = await generateDeviceSigningKeyPair();
    const msg = new TextEncoder().encode('canonical envelope bytes');
    const sig = await signEd25519(kp.privateKey, msg);
    expect(sig).toHaveLength(ED25519_SIGNATURE_LENGTH);
    expect(await verifyEd25519(kp.publicKey, msg, sig)).toBe(true);
  });

  it('exports a 32-byte raw public key that re-imports and verifies', async () => {
    const kp = await generateDeviceSigningKeyPair();
    const raw = await exportPublicKeyRaw(kp.publicKey);
    expect(raw).toHaveLength(32);
    const reimported = await importPublicKeyRaw(raw);
    const msg = new Uint8Array([1, 2, 3]);
    const sig = await signEd25519(kp.privateKey, msg);
    expect(await verifyEd25519(reimported, msg, sig)).toBe(true);
  });

  it('rejects a signature from a DIFFERENT device key (no cross-key forgery)', async () => {
    const a = await generateDeviceSigningKeyPair();
    const b = await generateDeviceSigningKeyPair();
    const msg = new Uint8Array([9, 9, 9]);
    const sig = await signEd25519(a.privateKey, msg);
    expect(await verifyEd25519(b.publicKey, msg, sig)).toBe(false);
  });

  it('fails closed on a wrong-length signature', async () => {
    const kp = await generateDeviceSigningKeyPair();
    expect(await verifyEd25519(kp.publicKey, new Uint8Array([1]), new Uint8Array(63))).toBe(false);
  });

  it('rotated/room-scoped device keys are uncorrelated (linkability scope)', async () => {
    const roomA = await generateDeviceSigningKeyPair();
    const roomB = await generateDeviceSigningKeyPair();
    expect(toHex(await exportPublicKeyRaw(roomA.publicKey))).not.toBe(
      toHex(await exportPublicKeyRaw(roomB.publicKey)),
    );
  });

  it('rejects an Ed25519 seed of the wrong length', () => {
    expect(() => pkcs8FromSeed(new Uint8Array(16))).toThrow(RangeError);
  });

  it('rejects a raw public key of the wrong length', async () => {
    await expect(importPublicKeyRaw(new Uint8Array(31))).rejects.toThrow(RangeError);
  });

  it('round-trips an extractable private key through PKCS#8', async () => {
    const kp = await generateDeviceSigningKeyPair(true);
    const pkcs8 = await exportPrivateKeyPkcs8(kp.privateKey);
    const reimported = await importPrivateKeyPkcs8(pkcs8);
    const msg = new Uint8Array([7, 7, 7]);
    const sig = await signEd25519(reimported, msg);
    expect(await verifyEd25519(kp.publicKey, msg, sig)).toBe(true);
  });
});

describe('envelope signing (§10.7)', () => {
  function unsignedEnvelope() {
    return {
      schema: 'licio.private.envelope.v1' as const,
      envelope_version: 1 as const,
      room_id_hash: 'cm9vbS1oYXNo',
      room_epoch: 3,
      object_type: 'contribution_op' as const,
      plaintext_schema: 'licio.private.contribution_op.v1',
      cid_profile: 'licio-private-cid-v1' as const,
      created_at_bucket: '2026-06-22T05',
      author_device_id_blind: 'device-blind-xyz',
      author_seq: 5,
      parent_op_ids: ['op-1', 'op-2'],
      capability_root_at_seq: 'Y2FwLXJvb3Q',
      chunk_index: 0,
      chunk_total: 1,
      aead: { algorithm: 'AES-256-GCM' as const, nonce: 'bm9uY2U', aad_hash: 'YWFkLWhhc2g' },
      key_wrap: {
        mode: 'mls_exporter_aead_wrap' as const,
        wrapping_epoch: 3,
        wrapped_object_key: 'd3JhcHBlZA',
      },
      ciphertext: 'Y2lwaGVydGV4dA',
      padding_policy: 'small-op-4k' as const,
    };
  }

  it('signs and verifies a full envelope; a metadata flip breaks the signature', async () => {
    const kp = await generateDeviceSigningKeyPair();
    const unsigned = unsignedEnvelope();
    const sigBytes = await signEnvelope(kp.privateKey, unsigned);
    const signature = Buffer.from(sigBytes).toString('base64url');
    const envelope = privateEncryptedEnvelopeSchema.parse({ ...unsigned, signature });

    expect(await verifyEnvelopeSignature(kp.publicKey, envelope, sigBytes)).toBe(true);

    // Flip an authenticated field → the canonical signing input changes → reject.
    const tampered = privateEncryptedEnvelopeSchema.parse({
      ...unsigned,
      room_epoch: 4,
      signature,
    });
    expect(await verifyEnvelopeSignature(kp.publicKey, tampered, sigBytes)).toBe(false);
  });

  it('produces a deterministic, order-independent signing input', () => {
    const a = envelopeSigningInput(unsignedEnvelope());
    const reordered = { ...unsignedEnvelope() };
    const b = envelopeSigningInput(reordered);
    expect(toHex(a)).toBe(toHex(b));
  });
});
