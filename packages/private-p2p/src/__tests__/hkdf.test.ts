// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.3.2 — HKDF key-schedule tests.  The RFC 5869 Appendix-A SHA-256 vectors
// pin `hkdfExtract`/`hkdfExpand` byte-exactly (including the empty-salt case the
// HPKE bootstrap relies on); the `HkdfLabel` structure is pinned against its
// TLS-1.3 / MLS byte layout; and the five-key schedule is checked for
// determinism, domain separation, length, and atomic epoch rotation.
import { describe, expect, it } from 'vitest';
import {
  deriveRoomEpochKeys,
  HKDF_LABEL_PREFIX,
  hkdfExpand,
  hkdfExpandLabel,
  hkdfExtract,
  hkdfLabel,
  ROOM_KEY_LABELS,
} from '../crypto/hkdf.js';

function hex(s: string): Uint8Array {
  const clean = s.replace(/\s+/g, '');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function toHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

// RFC 5869 Appendix A — Test Case 1 (SHA-256, basic).
const TC1 = {
  ikm: hex('0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b'),
  salt: hex('000102030405060708090a0b0c'),
  info: hex('f0f1f2f3f4f5f6f7f8f9'),
  prk: hex('077709362c2e32df0ddc3f0dc47bba6390b6c73bb50f9c3122ec844ad7c2b3e5'),
  okm: hex('3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865'),
};

// RFC 5869 Appendix A — Test Case 2 (SHA-256, longer inputs/output, 3 blocks).
const TC2 = {
  ikm: hex(
    '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f' +
      '202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f' +
      '404142434445464748494a4b4c4d4e4f',
  ),
  salt: hex(
    '606162636465666768696a6b6c6d6e6f707172737475767778797a7b7c7d7e7f' +
      '808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f' +
      'a0a1a2a3a4a5a6a7a8a9aaabacadaeaf',
  ),
  info: hex(
    'b0b1b2b3b4b5b6b7b8b9babbbcbdbebfc0c1c2c3c4c5c6c7c8c9cacbcccdcecf' +
      'd0d1d2d3d4d5d6d7d8d9dadbdcdddedfe0e1e2e3e4e5e6e7e8e9eaebecedeeef' +
      'f0f1f2f3f4f5f6f7f8f9fafbfcfdfeff',
  ),
  prk: hex('06a6b88c5853361a06104c9ceb35b45cef760014904671014a193f40c15fc244'),
  okm: hex(
    'b11e398dc80327a1c8e7f78c596a49344f012eda2d4efad8a050cc4c19afa97c' +
      '59045a99cac7827271cb41c65e590e09da3275600c2f09b8367793a9aca3db71' +
      'cc30c58179ec3e87c14c01d5c1f3434f1d87',
  ),
};

// RFC 5869 Appendix A — Test Case 3 (SHA-256, zero-length salt and info).
const TC3 = {
  ikm: hex('0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b'),
  salt: new Uint8Array(0),
  info: new Uint8Array(0),
  prk: hex('19ef24a32c717b167f33a91d6f648bdf96596776afdb6377ac434c1c293ccb04'),
  okm: hex('8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8'),
};

describe('HKDF RFC 5869 SHA-256 vectors', () => {
  it('Extract matches TC1 PRK (explicit salt)', async () => {
    expect(toHex(await hkdfExtract(TC1.salt, TC1.ikm))).toBe(toHex(TC1.prk));
  });

  it('Expand matches TC1 OKM (2 blocks)', async () => {
    expect(toHex(await hkdfExpand(TC1.prk, TC1.info, 42))).toBe(toHex(TC1.okm));
  });

  it('Expand matches TC2 OKM (3 blocks, 82 bytes)', async () => {
    expect(toHex(await hkdfExpand(TC2.prk, TC2.info, 82))).toBe(toHex(TC2.okm));
  });

  it('Extract with TC2 explicit salt matches TC2 PRK', async () => {
    expect(toHex(await hkdfExtract(TC2.salt, TC2.ikm))).toBe(toHex(TC2.prk));
  });

  it('Extract with EMPTY salt matches TC3 PRK (the HPKE empty-salt path)', async () => {
    expect(toHex(await hkdfExtract(TC3.salt, TC3.ikm))).toBe(toHex(TC3.prk));
  });

  it('Expand with empty info matches TC3 OKM', async () => {
    expect(toHex(await hkdfExpand(TC3.prk, TC3.info, 42))).toBe(toHex(TC3.okm));
  });

  it('rejects an output longer than 255 * HashLen', async () => {
    await expect(hkdfExpand(TC1.prk, TC1.info, 255 * 32 + 1)).rejects.toThrow(RangeError);
  });

  it('rejects a negative output length', async () => {
    await expect(hkdfExpand(TC1.prk, TC1.info, -1)).rejects.toThrow(RangeError);
  });
});

describe('HkdfLabel structure (TLS 1.3 / MLS)', () => {
  it('encodes uint16(length) || opaque label || opaque context', () => {
    const context = hex('aabbcc');
    const out = hkdfLabel(32, 'content-wrap.v1', context);
    const fullLabel = `${HKDF_LABEL_PREFIX}content-wrap.v1`;
    // uint16 length (0x0020) || label-len || label || context-len || context
    expect(out[0]).toBe(0x00);
    expect(out[1]).toBe(0x20);
    expect(out[2]).toBe(fullLabel.length);
    expect(new TextDecoder().decode(out.subarray(3, 3 + fullLabel.length))).toBe(fullLabel);
    const ctxLenIdx = 3 + fullLabel.length;
    expect(out[ctxLenIdx]).toBe(3);
    expect(toHex(out.subarray(ctxLenIdx + 1))).toBe('aabbcc');
  });

  it('rejects an over-long context (> 255 bytes)', () => {
    expect(() => hkdfLabel(32, 'x', new Uint8Array(256))).toThrow(RangeError);
  });

  it('rejects a length outside the uint16 range', () => {
    expect(() => hkdfLabel(0x1_0000, 'x', new Uint8Array(0))).toThrow(RangeError);
  });

  it('Expand-Label reduces to Expand over the HkdfLabel info', async () => {
    const secret = hex('11'.repeat(32));
    const context = hex('22'.repeat(16));
    const viaLabel = await hkdfExpandLabel(secret, 'sync-topic.v1', context, 32);
    const viaExpand = await hkdfExpand(secret, hkdfLabel(32, 'sync-topic.v1', context), 32);
    expect(toHex(viaLabel)).toBe(toHex(viaExpand));
  });
});

describe('deriveRoomEpochKeys (PRIVATE_SPEC §10.2 five-key schedule)', () => {
  const secret = hex('33'.repeat(32));
  const commitment = hex('44'.repeat(32));

  it('derives five distinct 32-byte keys (domain separation)', async () => {
    const keys = await deriveRoomEpochKeys(secret, commitment);
    const all = [
      keys.contentWrapKey,
      keys.syncTopicKey,
      keys.rendezvousKey,
      keys.snapshotKey,
      keys.reportKey,
    ];
    for (const k of all) expect(k).toHaveLength(32);
    const hexes = new Set(all.map(toHex));
    expect(hexes.size).toBe(5); // all five mutually independent
  });

  it('is deterministic across calls (cross-device convergence)', async () => {
    const a = await deriveRoomEpochKeys(secret, commitment);
    const b = await deriveRoomEpochKeys(secret, commitment);
    expect(toHex(a.contentWrapKey)).toBe(toHex(b.contentWrapKey));
    expect(toHex(a.reportKey)).toBe(toHex(b.reportKey));
  });

  it('rotates ALL five keys when the epoch secret changes', async () => {
    const epoch1 = await deriveRoomEpochKeys(secret, commitment);
    const epoch2 = await deriveRoomEpochKeys(hex('55'.repeat(32)), commitment);
    expect(toHex(epoch1.contentWrapKey)).not.toBe(toHex(epoch2.contentWrapKey));
    expect(toHex(epoch1.syncTopicKey)).not.toBe(toHex(epoch2.syncTopicKey));
    expect(toHex(epoch1.rendezvousKey)).not.toBe(toHex(epoch2.rendezvousKey));
    expect(toHex(epoch1.snapshotKey)).not.toBe(toHex(epoch2.snapshotKey));
    expect(toHex(epoch1.reportKey)).not.toBe(toHex(epoch2.reportKey));
  });

  it('binds keys to the room commitment (different room ⇒ different keys)', async () => {
    const roomA = await deriveRoomEpochKeys(secret, commitment);
    const roomB = await deriveRoomEpochKeys(secret, hex('66'.repeat(32)));
    expect(toHex(roomA.contentWrapKey)).not.toBe(toHex(roomB.contentWrapKey));
  });

  it('pins the §10.2 derivation labels', () => {
    expect(ROOM_KEY_LABELS).toStrictEqual({
      contentWrapKey: 'content-wrap.v1',
      syncTopicKey: 'sync-topic.v1',
      rendezvousKey: 'rendezvous.v1',
      snapshotKey: 'snapshot.v1',
      reportKey: 'voluntary-report.v1',
    });
  });
});
