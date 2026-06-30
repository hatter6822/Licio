// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.3.3a/b — object AEAD tests: body seal/open round-trip, per-field AAD-flip
// rejection (every authenticated field), the epoch-bound key-wrap replay
// defense, nonce/object-key uniqueness across a generated workload, and the
// §25.4 padding + §10.6 pad-not-compress rules.
import { describe, expect, it } from 'vitest';
import {
  aeadOpen,
  assertCompressionAllowed,
  type BodyAadInput,
  buildBodyAad,
  buildWrapAad,
  mayCompressObjectType,
  openBody,
  PADDING_BUCKET_4K,
  PADDING_BUCKET_16K,
  PrivateAeadError,
  padBody,
  paddedTargetSize,
  sealBody,
  selectPaddingPolicy,
  unpadBody,
  unwrapKey,
  type WrapAadInput,
  wrapKey,
} from '../crypto/aead.js';
import { randomBytes } from '../crypto/runtime.js';
import type { PrivateObjectType } from '../schemas/common.js';

const utf8 = (s: string) => new TextEncoder().encode(s);

function baseBodyAad(): BodyAadInput {
  return {
    envelopeVersion: 1,
    roomIdCommitment: utf8('room-commitment'),
    roomEpoch: 7,
    objectType: 'contribution_op',
    plaintextSchema: 'licio.private.contribution_op.v1',
    parentOpIds: ['op-b', 'op-a'],
    authorDeviceIdBlind: 'device-blind-1',
    authorSeq: 42,
    capabilityRootAtSeq: utf8('cap-root'),
    chunkIndex: 0,
    chunkTotal: 1,
  };
}

function baseWrapAad(): WrapAadInput {
  return {
    wrappingEpoch: 7,
    roomIdCommitment: utf8('room-commitment'),
    objectType: 'contribution_op',
  };
}

describe('object-body AEAD (§10.5)', () => {
  it('seals and opens a body round-trip', async () => {
    const plaintext = utf8('a private contribution body');
    const aad = baseBodyAad();
    const sealed = await sealBody(plaintext, aad, 'small-op-4k');
    expect(sealed.objectKey).toHaveLength(32);
    expect(sealed.nonce).toHaveLength(12);
    const opened = await openBody(sealed.objectKey, sealed.nonce, sealed.ciphertext, aad);
    expect(new TextDecoder().decode(opened)).toBe('a private contribution body');
  });

  it('produces a ciphertext length that reveals only the padding bucket', async () => {
    const aad = baseBodyAad();
    const a = await sealBody(utf8('short'), aad, 'small-op-4k');
    const b = await sealBody(utf8('a somewhat longer body but still under 4k'), aad, 'small-op-4k');
    // bucket (4096) + GCM tag (16) — identical regardless of true body length.
    expect(a.ciphertext.length).toBe(PADDING_BUCKET_4K + 16);
    expect(b.ciphertext.length).toBe(a.ciphertext.length);
  });

  it('fails closed when ANY authenticated AAD field is flipped', async () => {
    const plaintext = utf8('secret');
    const aad = baseBodyAad();
    const sealed = await sealBody(plaintext, aad, 'small-op-4k');

    const mutations: Array<(a: BodyAadInput) => BodyAadInput> = [
      (a) => ({ ...a, envelopeVersion: 2 }),
      (a) => ({ ...a, roomIdCommitment: utf8('other-room') }),
      (a) => ({ ...a, roomEpoch: 8 }),
      (a) => ({ ...a, objectType: 'story_op' }),
      (a) => ({ ...a, plaintextSchema: 'licio.private.story_op.v1' }),
      (a) => ({ ...a, parentOpIds: ['op-c'] }),
      (a) => ({ ...a, authorDeviceIdBlind: 'device-blind-2' }),
      (a) => ({ ...a, authorSeq: 43 }),
      (a) => ({ ...a, capabilityRootAtSeq: utf8('other-cap') }),
      (a) => ({ ...a, chunkIndex: 1 }),
      (a) => ({ ...a, chunkTotal: 2 }),
    ];
    for (const mutate of mutations) {
      await expect(
        openBody(sealed.objectKey, sealed.nonce, sealed.ciphertext, mutate(aad)),
      ).rejects.toMatchObject({ reason: 'aead_open_failed' });
    }
  });

  it('rejects a wrong-length key with a typed PrivateAeadError (PRIV-CRYPTO-2)', async () => {
    const aad = baseBodyAad();
    const sealed = await sealBody(utf8('body'), aad, 'small-op-4k');
    // A 31-byte (or any non-32) key must surface as the documented typed error, not a raw WebCrypto throw.
    const shortKey = sealed.objectKey.subarray(0, 31);
    await expect(openBody(shortKey, sealed.nonce, sealed.ciphertext, aad)).rejects.toMatchObject({
      name: 'PrivateAeadError',
      reason: 'object_key_wrong_length',
    });
    await expect(aeadOpen(new Uint8Array(16), new Uint8Array(40))).rejects.toMatchObject({
      reason: 'object_key_wrong_length',
    });
  });

  it('treats parent_op_ids as an unordered set (sorted canonically)', async () => {
    const sealed = await sealBody(
      utf8('x'),
      { ...baseBodyAad(), parentOpIds: ['op-a', 'op-b'] },
      'small-op-4k',
    );
    // The seal used ['op-a','op-b']; opening with the reversed order still works
    // because the AAD sorts canonically before encoding.
    const opened = await openBody(sealed.objectKey, sealed.nonce, sealed.ciphertext, {
      ...baseBodyAad(),
      parentOpIds: ['op-b', 'op-a'],
    });
    expect(new TextDecoder().decode(opened)).toBe('x');
  });

  it('fails closed on a tampered ciphertext byte', async () => {
    const aad = baseBodyAad();
    const sealed = await sealBody(utf8('secret'), aad, 'small-op-4k');
    const tampered = sealed.ciphertext.slice();
    tampered[0] = (tampered[0] as number) ^ 0xff;
    await expect(openBody(sealed.objectKey, sealed.nonce, tampered, aad)).rejects.toMatchObject({
      reason: 'aead_open_failed',
    });
  });
});

describe('object-key wrap AEAD (§10.4/§10.5)', () => {
  it('wraps and unwraps an object key round-trip', async () => {
    const objectKey = randomBytes(32);
    const contentWrapKey = randomBytes(32);
    const aad = baseWrapAad();
    const wrapped = await wrapKey(objectKey, contentWrapKey, aad);
    // wire form prefixes the 12-byte wrap nonce.
    expect(wrapped.length).toBe(12 + 32 + 16);
    const unwrapped = await unwrapKey(wrapped, contentWrapKey, aad);
    expect(Array.from(unwrapped)).toStrictEqual(Array.from(objectKey));
  });

  it('rejects an object key claiming a DIFFERENT wrapping epoch (replay defense)', async () => {
    const objectKey = randomBytes(32);
    const contentWrapKey = randomBytes(32);
    const wrapped = await wrapKey(objectKey, contentWrapKey, {
      ...baseWrapAad(),
      wrappingEpoch: 7,
    });
    // Same wrapping key, but the envelope now claims epoch 8 → AAD mismatch → fail.
    await expect(
      unwrapKey(wrapped, contentWrapKey, { ...baseWrapAad(), wrappingEpoch: 8 }),
    ).rejects.toMatchObject({ reason: 'aead_open_failed' });
  });

  it('rejects unwrapping under a different content_wrap_key', async () => {
    const objectKey = randomBytes(32);
    const wrapped = await wrapKey(objectKey, randomBytes(32), baseWrapAad());
    await expect(unwrapKey(wrapped, randomBytes(32), baseWrapAad())).rejects.toMatchObject({
      reason: 'aead_open_failed',
    });
  });

  it('rejects a malformed (too-short) wrapped key', async () => {
    await expect(
      unwrapKey(new Uint8Array(8), randomBytes(32), baseWrapAad()),
    ).rejects.toMatchObject({
      reason: 'malformed_wrapped_key',
    });
  });

  it('rejects wrapping a wrong-length object key', async () => {
    await expect(wrapKey(randomBytes(16), randomBytes(32), baseWrapAad())).rejects.toMatchObject({
      reason: 'object_key_wrong_length',
    });
  });
});

describe('nonce / object-key uniqueness (§10.6)', () => {
  it('never repeats a nonce or object key across a generated workload', async () => {
    const aad = baseBodyAad();
    const nonces = new Set<string>();
    const keys = new Set<string>();
    const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    for (let i = 0; i < 256; i++) {
      const sealed = await sealBody(utf8(`body-${i}`), aad, 'small-op-4k');
      const n = hex(sealed.nonce);
      const k = hex(sealed.objectKey);
      expect(nonces.has(n)).toBe(false);
      expect(keys.has(k)).toBe(false);
      nonces.add(n);
      keys.add(k);
    }
    expect(nonces.size).toBe(256);
    expect(keys.size).toBe(256);
  });
});

describe('padding (§25.4) and the §10.6 compression rule', () => {
  it('pads then unpads to recover the exact body for every policy', () => {
    for (const [policy, body] of [
      ['none', utf8('exact')],
      ['small-op-4k', utf8('four-k body')],
      ['small-op-16k', new Uint8Array(5000)],
      ['custom', new Uint8Array(9000)],
    ] as const) {
      const padded = padBody(body, policy);
      expect(padded.length).toBe(paddedTargetSize(body.length, policy));
      expect(Array.from(unpadBody(padded))).toStrictEqual(Array.from(body));
    }
  });

  it('pads small-op-4k / small-op-16k to fixed bucket sizes', () => {
    expect(padBody(utf8('x'), 'small-op-4k')).toHaveLength(PADDING_BUCKET_4K);
    expect(padBody(new Uint8Array(5000), 'small-op-16k')).toHaveLength(PADDING_BUCKET_16K);
  });

  it('throws when a body does not fit the chosen fixed bucket', () => {
    expect(() => padBody(new Uint8Array(PADDING_BUCKET_4K), 'small-op-4k')).toThrow(
      PrivateAeadError,
    );
  });

  it('selects the smallest bucket that fits', () => {
    expect(selectPaddingPolicy(10)).toBe('small-op-4k');
    expect(selectPaddingPolicy(5000)).toBe('small-op-16k');
    expect(selectPaddingPolicy(50_000)).toBe('custom');
  });

  it('rejects an out-of-bounds declared padding length', () => {
    const bad = new Uint8Array(8);
    bad[0] = 0xff; // declares a 4 GiB length in an 8-byte buffer
    expect(() => unpadBody(bad)).toThrow(PrivateAeadError);
  });

  it('forbids compressing any secret body class, allows only local search shards (§10.6)', () => {
    const forbidden: PrivateObjectType[] = [
      'room_manifest',
      'membership_op',
      'story_op',
      'thread_op',
      'contribution_op',
      'attachment_manifest',
      'media_chunk',
      'snapshot',
    ];
    for (const t of forbidden) {
      expect(mayCompressObjectType(t)).toBe(false);
      expect(() => assertCompressionAllowed(t)).toThrow(PrivateAeadError);
    }
    expect(mayCompressObjectType('local_index_shard')).toBe(true);
    expect(() => assertCompressionAllowed('local_index_shard')).not.toThrow();
  });
});

describe('canonical AAD shape', () => {
  it('puts the domain tag first and is deterministic', () => {
    const a = buildBodyAad(baseBodyAad());
    const b = buildBodyAad(baseBodyAad());
    expect(Array.from(a)).toStrictEqual(Array.from(b));
    // first element is the text "licio-priv1.body": CBOR tstr head 0x70 | len(16)=0x70.
    expect(a[1]).toBe(0x70); // a[0] = array head (0x8c = array(12))
    expect(a[0]).toBe(0x8c);
  });

  it('wrap AAD is a four-element array tagged licio-priv1.keywrap', () => {
    const w = buildWrapAad(baseWrapAad());
    expect(w[0]).toBe(0x84); // array(4)
  });
});
