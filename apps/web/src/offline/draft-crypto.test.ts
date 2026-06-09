// SPDX-License-Identifier: AGPL-3.0-or-later
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
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
});
