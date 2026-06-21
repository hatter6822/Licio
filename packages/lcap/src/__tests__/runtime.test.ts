// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The runtime crypto adapter — resolves WebCrypto from `globalThis` and adapts
// `Uint8Array` to the `BufferSource` WebCrypto requires.

import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { encode } from '../cbor/encode.js';
import { cidFor } from '../cid/index.js';
import {
  getCrypto,
  getSubtle,
  isUint8Array,
  LcapCryptoUnavailableError,
  toBufferSource,
} from '../runtime.js';
import { decodeWithSchema, encodeWithSchema } from '../schemas/codec.js';
import { packTableV2Schema } from '../schemas/pack.js';

describe('runtime crypto adapter', () => {
  it('resolves the global Crypto / SubtleCrypto', () => {
    expect(typeof getCrypto().subtle.digest).toBe('function');
    expect(getSubtle()).toBe(getCrypto().subtle);
  });

  it('adapts an ArrayBuffer-backed Uint8Array without copying', () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const view = toBufferSource(bytes);
    expect(view).toBe(bytes); // ArrayBuffer-backed → no copy
    expect(view.buffer).toBeInstanceOf(ArrayBuffer);
  });

  it('copies a non-ArrayBuffer-backed (shared) Uint8Array to stay sound', () => {
    const shared = new Uint8Array(new SharedArrayBuffer(3));
    shared.set([4, 5, 6]);
    const view = toBufferSource(shared);
    expect(view).not.toBe(shared); // shared-backed → copied
    expect(view.buffer).toBeInstanceOf(ArrayBuffer);
    expect(Array.from(view)).toEqual([4, 5, 6]);
  });

  it('round-trips through subtle.digest using the adapter', async () => {
    const digest = await getSubtle().digest('SHA-256', toBufferSource(new Uint8Array()));
    expect(new Uint8Array(digest).length).toBe(32);
  });
});

describe('isUint8Array — realm-tolerant byte guard', () => {
  it('accepts a same-realm Uint8Array and rejects non-byte values', () => {
    expect(isUint8Array(new Uint8Array([1, 2, 3]))).toBe(true);
    expect(isUint8Array(new DataView(new ArrayBuffer(4)))).toBe(false);
    expect(isUint8Array(new ArrayBuffer(4))).toBe(false);
    expect(isUint8Array([1, 2, 3])).toBe(false);
    expect(isUint8Array('bytes')).toBe(false);
    expect(isUint8Array(null)).toBe(false);
  });

  it('accepts a CROSS-REALM Uint8Array (where `instanceof` fails)', () => {
    // A Uint8Array built in a fresh realm fails `instanceof Uint8Array` here but is a
    // genuine byte array — exactly the Web-Worker / jsdom split the codec must survive.
    const foreign = runInNewContext('new Uint8Array([7, 8, 9])') as Uint8Array;
    expect(foreign instanceof Uint8Array).toBe(false); // the fragility this guards against
    expect(isUint8Array(foreign)).toBe(true);
  });

  it('encodes a cross-realm byte string as CBOR bytes (not an int array)', () => {
    const foreign = runInNewContext('new Uint8Array([1, 2, 3, 4])') as Uint8Array;
    // The codec must treat it as a byte string: a major-type-2 header (0x44 = bytes,
    // length 4), NOT an array (major type 4) of four integers.
    expect(encode(foreign)[0]).toBe(0x44);
  });

  it('round-trips a cross-realm room_id_hash through the pack table schema', async () => {
    const foreign = runInNewContext('new Uint8Array([10, 20, 30, 40])') as Uint8Array;
    const cid = await cidFor('record', new Uint8Array([1]));
    const table = {
      entries: [
        {
          cid,
          cid_kind: 'record' as const,
          lane: 'T1' as const,
          priority: 1 as const,
          offset: 0,
          length: 10,
          room_id_hash: foreign,
        },
      ],
    };
    const decoded = decodeWithSchema(packTableV2Schema, encodeWithSchema(packTableV2Schema, table));
    expect(decoded.entries[0]?.room_id_hash).toEqual(new Uint8Array([10, 20, 30, 40]));
  });
});

describe('runtime crypto adapter — fail-closed', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('LcapCryptoUnavailableError carries a stable name + WebCrypto message', () => {
    const err = new LcapCryptoUnavailableError();
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('LcapCryptoUnavailableError');
    expect(err.message).toContain('WebCrypto');
  });

  it('getCrypto throws LcapCryptoUnavailableError when WebCrypto is absent', async () => {
    vi.resetModules();
    vi.stubGlobal('crypto', undefined);
    const fresh = await import('../runtime.js');
    expect(() => fresh.getCrypto()).toThrow(fresh.LcapCryptoUnavailableError);
  });

  it('getCrypto throws when subtle.digest is not callable', async () => {
    vi.resetModules();
    vi.stubGlobal('crypto', { subtle: {} } as unknown as Crypto);
    const fresh = await import('../runtime.js');
    expect(() => fresh.getCrypto()).toThrow(fresh.LcapCryptoUnavailableError);
  });
});
