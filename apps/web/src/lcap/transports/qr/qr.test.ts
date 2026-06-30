// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.15.2 — the QR micro-bundle codec: the hand-rolled byte-mode encoder is proven
// CORRECT by a jsQR round-trip (encode → render to pixels → jsQR decode → identical
// bytes) across versions 1–4 and several payloads; a too-large payload is rejected (QR
// carries only tiny control material).
import { describe, expect, it } from 'vitest';
import { decodeQr } from './qr-decode.js';
import { encodeQr, QR_MAX_PAYLOAD_BYTES } from './qr-encode.js';
import { renderToImageData } from './qr-render.js';

// Compare as plain number arrays — realm-independent (a jsdom-realm Uint8Array and a
// Node-realm one have identical bytes but different constructors, which `toEqual` on the
// typed arrays would treat as unequal).
async function roundTrip(payload: Uint8Array): Promise<number[] | null> {
  const { modules } = encodeQr(payload);
  const image = renderToImageData(modules, { scale: 8, quietZone: 4 });
  const decoded = await decodeQr(image);
  return decoded ? [...decoded] : null;
}

describe('QR encode → jsQR decode round-trip', () => {
  it('round-trips a short ASCII control string', async () => {
    const payload = Uint8Array.from(new TextEncoder().encode('lcap:invite:room42'));
    expect(await roundTrip(payload)).toEqual([...payload]);
  });

  it('round-trips arbitrary bytes (a tiny signed-notice stand-in)', async () => {
    const payload = Uint8Array.from({ length: 24 }, (_, i) => (i * 37 + 5) & 0xff);
    expect(await roundTrip(payload)).toEqual([...payload]);
  });

  it('round-trips across versions 1–4 as the payload grows', async () => {
    for (const len of [5, 20, 45, 70]) {
      const payload = Uint8Array.from({ length: len }, (_, i) => (i * 13 + 1) & 0xff);
      const { version } = encodeQr(payload);
      expect(version).toBeGreaterThanOrEqual(1);
      expect(await roundTrip(payload)).toEqual([...payload]);
    }
  });
});

describe('QR capacity bound (tiny control only)', () => {
  it('rejects a payload too large for a v1–4 QR', () => {
    expect(() => encodeQr(new Uint8Array(200))).toThrow(/too large/);
  });
});

describe('QR structural assertions (PUB-QR-2)', () => {
  it('sets the always-dark module at (size-8, 8) (PUB-QR-1 regression)', () => {
    const { modules, size } = encodeQr(new TextEncoder().encode('x'));
    // The §8.9 dark module must be set; the old format-copy-2 loop clobbered it.
    expect(modules[size - 8]?.[8]).toBe(true);
  });

  it('encodes exactly the max payload as v4 and rejects one byte more (boundary)', () => {
    expect(QR_MAX_PAYLOAD_BYTES).toBe(78);
    expect(encodeQr(new Uint8Array(QR_MAX_PAYLOAD_BYTES)).version).toBe(4);
    expect(() => encodeQr(new Uint8Array(QR_MAX_PAYLOAD_BYTES + 1))).toThrow(/too large/);
  });

  it('a full v4 payload round-trips — both format copies + the dark module must be correct', async () => {
    // jsQR reads BOTH format-info copies + the dark module to decode; a corrupt copy 2 (PUB-QR-1) or
    // a clobbered dark module would break this v4 (size-33) decode.
    const payload = Uint8Array.from(
      { length: QR_MAX_PAYLOAD_BYTES },
      (_, i) => (i * 11 + 7) & 0xff,
    );
    const { version } = encodeQr(payload);
    expect(version).toBe(4);
    expect(await roundTrip(payload)).toEqual([...payload]);
  });
});
