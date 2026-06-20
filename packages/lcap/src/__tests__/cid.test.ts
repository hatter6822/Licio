// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.0.3 — CID construction.  The digest half is grounded against published
// SHA-256 known-answer vectors; the layout/prefix/coherence checks pin the
// §9.2 binary form, so a record digest can never be reparsed as a block CID.

import { describe, expect, it } from 'vitest';
import { Base32Error, base32Decode, base32Encode } from '../cid/base32.js';
import { CidError, type CidKind, cidBytesFor, cidFor, parseCid, verifyCid } from '../cid/index.js';
import { bytesToHex, hexToBytes } from './hex.js';

const KINDS: CidKind[] = ['record', 'proof', 'block', 'chunk'];
const PREFIX: Record<CidKind, string> = {
  record: 'lcapr_',
  proof: 'lcapp_',
  block: 'lcapb_',
  chunk: 'lcapc_',
};

describe('base32 (RFC 4648 §6, lower-case, no padding)', () => {
  it('round-trips and matches RFC 4648 test vectors', () => {
    // RFC 4648 §10: "foobar" → "mzxw6ytboi" (lower-cased, unpadded).
    expect(base32Encode(new TextEncoder().encode('foobar'))).toBe('mzxw6ytboi');
    for (const hex of ['', '00', 'ff', 'deadbeef', '0102030405060708']) {
      const bytes = hexToBytes(hex);
      expect(bytesToHex(base32Decode(base32Encode(bytes)))).toBe(hex);
    }
  });

  it('rejects out-of-alphabet characters and non-canonical padding', () => {
    expect(() => base32Decode('MZXW6YTB')).toThrow(Base32Error); // upper-case
    expect(() => base32Decode('0189')).toThrow(Base32Error); // 0,1,8,9 not in alphabet
    expect(() => base32Decode('a')).toThrow(Base32Error); // 5 leftover bits
  });
});

describe('CID construction (WS-R.0.3)', () => {
  it('binds the SHA-256 of the body (known-answer grounded)', async () => {
    const empty = await cidBytesFor('record', new Uint8Array());
    expect(bytesToHex(empty.subarray(4))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    const abc = await cidBytesFor('record', new TextEncoder().encode('abc'));
    expect(bytesToHex(abc.subarray(4))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('emits the §9.2 layout: 0x01 || kind_code || 0x12 0x20 || digest', async () => {
    const codes: Record<CidKind, number> = { record: 1, proof: 2, block: 3, chunk: 4 };
    for (const kind of KINDS) {
      const bytes = await cidBytesFor(kind, new Uint8Array([1, 2, 3]));
      expect(bytes.length).toBe(36);
      expect([...bytes.subarray(0, 4)]).toEqual([0x01, codes[kind], 0x12, 0x20]);
      const cid = await cidFor(kind, new Uint8Array([1, 2, 3]));
      expect(cid.startsWith(PREFIX[kind])).toBe(true);
      expect(parseCid(cid).kind).toBe(kind);
    }
  });

  it('parses and verifies, and verifyCid is true only for the exact body', async () => {
    const body = new TextEncoder().encode('hello licio');
    const cid = await cidFor('block', body);
    const parsed = parseCid(cid);
    expect(parsed.kind).toBe('block');
    expect(parsed.digest.length).toBe(32);
    expect(await verifyCid(cid, body)).toBe(true);
    expect(await verifyCid(cid, new TextEncoder().encode('hello world'))).toBe(false);
  });

  it('rejects a human-prefix ↔ kind_code disagreement (no cross-kind reparse)', async () => {
    const recordCid = await cidFor('record', new Uint8Array([9]));
    const body32 = recordCid.slice(PREFIX.record.length);
    // Same bytes (kind_code 0x01), but advertised under the block prefix.
    try {
      parseCid(PREFIX.block + body32);
      throw new Error('expected CidError');
    } catch (error) {
      expect(error).toBeInstanceOf(CidError);
      expect((error as CidError).reason).toBe('prefix_kind_mismatch');
    }
  });

  it('rejects unknown prefix, bad base32, wrong length, version, and multihash', () => {
    const fail = (cid: string): string => {
      try {
        parseCid(cid);
      } catch (error) {
        if (error instanceof CidError) return error.reason;
      }
      throw new Error(`expected CidError for ${cid}`);
    };
    expect(fail('xyz_aaaa')).toBe('unknown_prefix');
    expect(fail('lcapr_AAA')).toBe('bad_base32'); // upper-case is out of alphabet
    expect(fail(`lcapr_${base32Encode(new Uint8Array(10))}`)).toBe('bad_length');
    const badVersion = new Uint8Array(36);
    badVersion.set([0x02, 0x01, 0x12, 0x20]); // version 0x02
    expect(fail(`lcapr_${base32Encode(badVersion)}`)).toBe('bad_version');
    const badMh = new Uint8Array(36);
    badMh.set([0x01, 0x01, 0x11, 0x20]); // multihash 0x11, not 0x12
    expect(fail(`lcapr_${base32Encode(badMh)}`)).toBe('bad_multihash');
  });
});
