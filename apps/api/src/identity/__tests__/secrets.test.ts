// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { createLocalSecretBox } from '../secrets.js';

const SECRET = 'master-secret-at-least-32-characters-long!!';

describe('createLocalSecretBox (AES-256-GCM)', () => {
  it('round-trips a string and a byte buffer', () => {
    const box = createLocalSecretBox(SECRET);
    expect(box.open(box.seal('hello totp secret')).toString('utf8')).toBe('hello totp secret');
    const bytes = Buffer.from([1, 2, 3, 4, 5]);
    expect(box.open(box.seal(bytes)).equals(bytes)).toBe(true);
  });

  it('produces a fresh IV each time (ciphertexts differ for the same plaintext)', () => {
    const box = createLocalSecretBox(SECRET);
    expect(box.seal('same')).not.toBe(box.seal('same'));
  });

  it('never stores the plaintext in the sealed token', () => {
    const box = createLocalSecretBox(SECRET);
    const sealed = box.seal('SUPERSECRETVALUE');
    expect(sealed).not.toContain('SUPERSECRETVALUE');
    expect(sealed.startsWith('v1.')).toBe(true);
  });

  it('detects tampering (GCM auth tag) and throws', () => {
    const box = createLocalSecretBox(SECRET);
    const sealed = box.seal('integrity');
    const parts = sealed.split('.');
    // Flip a byte in the ciphertext.
    const ct = Buffer.from(parts[2] as string, 'base64url');
    ct[0] = (ct[0] ?? 0) ^ 0xff;
    parts[2] = ct.toString('base64url');
    expect(() => box.open(parts.join('.'))).toThrow();
  });

  it('rejects a truncated GCM auth tag (full 128-bit tag enforced)', () => {
    const box = createLocalSecretBox(SECRET);
    const sealed = box.seal('tag-truncation');
    const parts = sealed.split('.');
    const fullTag = Buffer.from(parts[3] as string, 'base64url');
    // A shortened tag must never authenticate — otherwise forgery resistance
    // collapses from 2^128 to 2^(8·len).
    for (const len of [12, 8, 4]) {
      const truncated = fullTag.subarray(0, len).toString('base64url');
      expect(() => box.open([parts[0], parts[1], parts[2], truncated].join('.'))).toThrow(
        'secret-box: bad tag',
      );
    }
  });

  it('cannot be opened with a different master secret', () => {
    const sealed = createLocalSecretBox(SECRET).seal('cross-key');
    expect(() => createLocalSecretBox(`${SECRET}-other`).open(sealed)).toThrow();
  });

  it('rejects a malformed token', () => {
    const box = createLocalSecretBox(SECRET);
    expect(() => box.open('not-a-token')).toThrow();
    expect(() => box.open('v2.a.b.c')).toThrow();
  });
});
