// SPDX-License-Identifier: AGPL-3.0-or-later
//
// PUB-WEB-CARRIERS-4 — pin the PUBLIC signaling-key derivation against an INDEPENDENT HKDF
// reference (Node's `crypto.hkdfSync`), so a regression in the WebCrypto HKDF parameters
// (salt / info / length) is caught — not merely re-confirmed by recomputing via the function
// under test.
import { hkdfSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { derivePublicSignalKeyBytes } from './signal-key.js';

/** The domain-separation info string the public signaling key MUST use (the spec'd constant). */
const PUBLIC_SIGNAL_KEY_INFO = 'lcap:p2p:signal-key:public:v1';

/** An INDEPENDENT HKDF-SHA-256 reference — NOT the function under test. */
function independentHkdf(roomIdHash: Uint8Array): Uint8Array {
  return new Uint8Array(
    hkdfSync(
      'sha256',
      roomIdHash,
      new Uint8Array(0),
      new TextEncoder().encode(PUBLIC_SIGNAL_KEY_INFO),
      32,
    ),
  );
}

describe('derivePublicSignalKeyBytes (PUB-WEB-CARRIERS-4)', () => {
  // A fixed, frozen 32-byte room_id_hash so the vector is reproducible.
  const roomIdHash = Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 3) & 0xff);

  it('matches an INDEPENDENT HKDF-SHA-256(ikm=room_id_hash, salt="", info=…public:v1, L=32) reference', async () => {
    const got = await derivePublicSignalKeyBytes(roomIdHash);
    expect(Array.from(got)).toStrictEqual(Array.from(independentHkdf(roomIdHash)));
  });

  it('derives exactly 32 bytes', async () => {
    expect((await derivePublicSignalKeyBytes(roomIdHash)).length).toBe(32);
  });

  it('is deterministic — the same room_id_hash yields the same key', async () => {
    const a = await derivePublicSignalKeyBytes(roomIdHash);
    const b = await derivePublicSignalKeyBytes(roomIdHash);
    expect(Array.from(a)).toStrictEqual(Array.from(b));
  });

  it('domain-separates — a different room_id_hash yields a different key', async () => {
    const a = await derivePublicSignalKeyBytes(roomIdHash);
    const b = await derivePublicSignalKeyBytes(new Uint8Array(32).fill(9));
    expect(Array.from(a)).not.toStrictEqual(Array.from(b));
  });

  it('uses the exact spec info-string constant (the KAT above also enforces this)', () => {
    // The KAT match proves the function under test uses THIS info string; a drift would mismatch.
    expect(PUBLIC_SIGNAL_KEY_INFO).toBe('lcap:p2p:signal-key:public:v1');
  });
});
