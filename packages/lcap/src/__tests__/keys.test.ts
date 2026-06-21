// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.0.5b — device key lifecycle + COSE_Key round-trip.  The private key is
// non-extractable (its raw bytes never serialize); the public key round-trips
// through COSE_Key bytes and still verifies a signature made by the original
// private key.

import { describe, expect, it } from 'vitest';
import { decode } from '../cbor/decode.js';
import { signEs256, verifyEs256 } from '../cose/ecdsa.js';
import { exportPublicKeyCose, generateDeviceKey, importPublicKeyCose } from '../cose/keys.js';
import { getSubtle } from '../runtime.js';

describe('device key lifecycle (WS-R.0.5b)', () => {
  it('generates a non-extractable private key', async () => {
    const { privateKey, publicKey } = await generateDeviceKey();
    expect(privateKey.extractable).toBe(false);
    // The public key remains extractable (so it can become a COSE_Key).
    expect(publicKey.extractable).toBe(true);
    await expect(getSubtle().exportKey('jwk', privateKey)).rejects.toThrow();
    await expect(getSubtle().exportKey('pkcs8', privateKey)).rejects.toThrow();
  });

  it('encodes the public key as a COSE_Key (EC2 / P-256 / x / y)', async () => {
    const { publicKey } = await generateDeviceKey();
    const cose = await exportPublicKeyCose(publicKey);
    const decoded = decode(cose);
    expect(decoded).toBeInstanceOf(Map);
    const map = decoded as Map<number, unknown>;
    expect(map.get(1)).toBe(2); // kty: EC2
    expect(map.get(-1)).toBe(1); // crv: P-256
    expect(map.get(-2)).toBeInstanceOf(Uint8Array); // x
    expect(map.get(-3)).toBeInstanceOf(Uint8Array); // y
    expect((map.get(-2) as Uint8Array).length).toBe(32);
    expect((map.get(-3) as Uint8Array).length).toBe(32);
  });

  it('round-trips: the re-imported public key verifies the original signature', async () => {
    const { privateKey, publicKey } = await generateDeviceKey();
    const message = new TextEncoder().encode('round-trip');
    const sig = await signEs256(privateKey, message);

    const reimported = await importPublicKeyCose(await exportPublicKeyCose(publicKey));
    expect(await verifyEs256(reimported, message, sig)).toBe(true);
    expect(await verifyEs256(reimported, new TextEncoder().encode('tampered'), sig)).toBe(false);
  });

  it('rejects a malformed COSE_Key', async () => {
    await expect(importPublicKeyCose(new Uint8Array([0xf6]))).rejects.toThrow(); // null, not a map
  });
});
