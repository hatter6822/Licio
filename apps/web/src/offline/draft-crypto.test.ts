// SPDX-License-Identifier: AGPL-3.0-or-later
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { decryptDraftValues, encryptDraftValues, resetDraftKeyCache } from './draft-crypto.js';

function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
}

beforeEach(async () => {
  resetDraftKeyCache();
  await deleteDatabase('licio-keys');
});

describe('draft-crypto', () => {
  it('round-trips values through AES-GCM without storing plaintext', async () => {
    const values = { headline: 'A measured point', evidence: 'A primary source' };
    const cipher = await encryptDraftValues(values);
    if (!cipher) throw new Error('expected a cipher in a Web Crypto environment');
    expect(cipher.data).not.toContain('measured');
    expect(await decryptDraftValues(cipher)).toEqual(values);
  });

  // AES-GCM nonce reuse under one key is catastrophic, not degraded: two
  // ciphertexts sharing an IV leak P1 ⊕ P2 and expose the GHASH authentication
  // key, making the tag forgeable. `crypto.getRandomValues` on every encrypt is
  // therefore load-bearing, and every OTHER assertion in this file passes with a
  // hard-coded nonce — so it needs its own pin.
  it('never reuses an AES-GCM IV, and pins the 96-bit width', async () => {
    // Identical plaintext every round is deliberate: it also kills an SIV-style
    // hash-of-plaintext IV, which would otherwise look "random enough".
    const ivs = new Set<string>();
    for (let i = 0; i < 50; i += 1) {
      const cipher = await encryptDraftValues({ a: 'same-plaintext' });
      if (!cipher) throw new Error('expected a cipher');
      expect(atob(cipher.iv).length).toBe(12);
      ivs.add(cipher.iv);
    }
    expect(ivs.size).toBe(50);
  });

  it('never reuses an IV across a reload (the nonce is not module state)', async () => {
    // The loop above cannot see a counter that resets on reload, which is exactly
    // what a module-level nonce becomes. Both lifetimes must start from FRESH
    // module state, or the assertion silently depends on test order.
    async function ivsFromFreshModule(): Promise<string[]> {
      vi.resetModules();
      const mod = await import('./draft-crypto.js');
      const out: string[] = [];
      for (let i = 0; i < 5; i += 1) {
        const cipher = await mod.encryptDraftValues({ a: 'same-plaintext' });
        if (!cipher) throw new Error('expected a cipher');
        out.push(cipher.iv);
      }
      return out;
    }
    const first = new Set(await ivsFromFreshModule());
    for (const iv of await ivsFromFreshModule()) expect(first.has(iv)).toBe(false);
  });

  it('returns null when the ciphertext cannot be authenticated', async () => {
    const cipher = await encryptDraftValues({ a: 'b' });
    if (!cipher) throw new Error('expected a cipher');
    // A wrong IV makes the GCM auth tag fail to verify.
    const tampered = { iv: btoa('\0'.repeat(12)), data: cipher.data };
    expect(await decryptDraftValues(tampered)).toBeNull();
  });

  it('reuses the persisted key across a simulated reload', async () => {
    const cipher = await encryptDraftValues({ x: '1' });
    if (!cipher) throw new Error('expected a cipher');
    resetDraftKeyCache(); // drop the in-memory handle; key reloads from the key store
    expect(await decryptDraftValues(cipher)).toEqual({ x: '1' });
  });

  it('rejects a flipped ciphertext byte (GCM auth tag)', async () => {
    const cipher = await encryptDraftValues({ a: 'b' });
    if (!cipher) throw new Error('expected a cipher');
    // Flip the first base64 char of the ciphertext (changes a byte; tag fails).
    const data = cipher.data;
    const flipped = (data[0] === 'A' ? 'B' : 'A') + data.slice(1);
    expect(await decryptDraftValues({ iv: cipher.iv, data: flipped })).toBeNull();
  });

  it('rejects decryption under a different key (wrong-key)', async () => {
    const cipher = await encryptDraftValues({ secret: 'x' });
    if (!cipher) throw new Error('expected a cipher');
    // Replace the key store so a NEW, unrelated key is generated.
    resetDraftKeyCache();
    await deleteDatabase('licio-keys');
    expect(await decryptDraftValues(cipher)).toBeNull();
  });

  it('persists a NON-EXTRACTABLE key — no exportable key material at rest', async () => {
    await encryptDraftValues({ a: 'b' }); // creates + persists the key
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open('licio-keys', 1);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    const record = await new Promise<{ id: string; key: CryptoKey } | undefined>(
      (resolve, reject) => {
        const rq = db.transaction('keys').objectStore('keys').get('draft-aes-gcm');
        rq.onsuccess = () => resolve(rq.result);
        rq.onerror = () => reject(rq.error);
      },
    );
    db.close();
    // The stored value is the CryptoKey itself (not a JWK / raw bytes)…
    expect(record?.key).toBeInstanceOf(CryptoKey);
    expect(record?.key.extractable).toBe(false);
    // …and its bytes can never be exported.
    if (record) {
      await expect(crypto.subtle.exportKey('raw', record.key)).rejects.toThrow();
    }
  });
});
