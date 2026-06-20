// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The runtime crypto adapter — resolves WebCrypto from `globalThis` and adapts
// `Uint8Array` to the `BufferSource` WebCrypto requires.

import { describe, expect, it } from 'vitest';
import { getCrypto, getSubtle, toBufferSource } from '../runtime.js';

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

  it('round-trips through subtle.digest using the adapter', async () => {
    const digest = await getSubtle().digest('SHA-256', toBufferSource(new Uint8Array()));
    expect(new Uint8Array(digest).length).toBe(32);
  });
});
