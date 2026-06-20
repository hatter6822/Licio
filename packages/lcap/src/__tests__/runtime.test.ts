// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The runtime crypto adapter — resolves WebCrypto from `globalThis` and adapts
// `Uint8Array` to the `BufferSource` WebCrypto requires.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { getCrypto, getSubtle, LcapCryptoUnavailableError, toBufferSource } from '../runtime.js';

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
