// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.6.2/6.3 — X25519 ECDH tests: key generation, the agreement property
// (A·b == B·a), and malformed-peer-key rejection.
import { describe, expect, it } from 'vitest';
import {
  generateX25519KeyPair,
  X25519_PUBLIC_KEY_LENGTH,
  x25519SharedSecret,
} from '../crypto/ecdh.js';

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

describe('generateX25519KeyPair', () => {
  it('produces a 32-byte public key and a usable private key', async () => {
    const pair = await generateX25519KeyPair();
    expect(pair.publicKey).toHaveLength(X25519_PUBLIC_KEY_LENGTH);
    expect(pair.privateKey.type).toBe('private');
  });

  it('produces distinct key pairs per call', async () => {
    const a = await generateX25519KeyPair();
    const b = await generateX25519KeyPair();
    expect(hex(a.publicKey)).not.toBe(hex(b.publicKey));
  });

  it('can mint an extractable private key when asked (and it still agrees)', async () => {
    const a = await generateX25519KeyPair(true);
    const b = await generateX25519KeyPair();
    expect(a.privateKey.extractable).toBe(true);
    // An extractable key still performs ECDH identically.
    expect(hex(await x25519SharedSecret(a.privateKey, b.publicKey))).toBe(
      hex(await x25519SharedSecret(b.privateKey, a.publicKey)),
    );
  });
});

describe('x25519SharedSecret — the agreement property', () => {
  it('A·b == B·a (both peers derive the same secret)', async () => {
    const a = await generateX25519KeyPair();
    const b = await generateX25519KeyPair();
    const ab = await x25519SharedSecret(a.privateKey, b.publicKey);
    const ba = await x25519SharedSecret(b.privateKey, a.publicKey);
    expect(ab).toHaveLength(32);
    expect(hex(ab)).toBe(hex(ba));
  });

  it('a different counterparty yields a different secret', async () => {
    const a = await generateX25519KeyPair();
    const b = await generateX25519KeyPair();
    const c = await generateX25519KeyPair();
    expect(hex(await x25519SharedSecret(a.privateKey, b.publicKey))).not.toBe(
      hex(await x25519SharedSecret(a.privateKey, c.publicKey)),
    );
  });

  it('rejects a malformed peer public key', async () => {
    const a = await generateX25519KeyPair();
    await expect(x25519SharedSecret(a.privateKey, new Uint8Array(31))).rejects.toThrow();
  });
});
