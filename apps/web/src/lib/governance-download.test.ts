// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-U member offline-verification: the downloaded governance-model bundle bytes
// must be the CANONICAL (key-sorted, whitespace-free) bytes the server digested,
// so a member who hashes the file reproduces `artifact_digest`. Pretty-printed
// bytes would not hash to the digest, silently defeating the accountability core.
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalBundleBytes, downloadModelBundle } from './governance-download.js';

const sha256hex = (s: string) => createHash('sha256').update(s).digest('hex');

describe('canonicalBundleBytes', () => {
  it('sorts keys recursively and emits no whitespace', () => {
    const bytes = canonicalBundleBytes({ b: 1, a: { d: 4, c: 3 }, arr: [{ z: 1, y: 2 }] });
    expect(bytes).toBe('{"a":{"c":3,"d":4},"arr":[{"y":2,"z":1}],"b":1}');
  });
});

describe('downloadModelBundle', () => {
  afterEach(() => vi.restoreAllMocks());

  it('writes the canonical bytes that hash to artifact_digest and names the file by it', async () => {
    const bundle = { name: 'Civility', bundleId: 'b1', version: '1' };
    // The server digests sha256(canonicalize(bundle)); a member must reproduce it.
    const digest = sha256hex(canonicalBundleBytes(bundle));

    let captured: Blob | null = null;
    const createObjectURL = vi.fn((b: Blob) => {
      captured = b;
      return 'blob:x';
    });
    vi.stubGlobal('URL', {
      createObjectURL,
      revokeObjectURL: vi.fn(),
    } as unknown as typeof URL);
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    downloadModelBundle({ model_id: 'm1', artifact_digest: digest, bundle });

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(captured).not.toBeNull();
    const text = await (captured as unknown as Blob).text();
    // The written bytes hash to the advertised digest (offline verification works).
    expect(sha256hex(text)).toBe(digest);
    expect(click).toHaveBeenCalled();
  });
});
