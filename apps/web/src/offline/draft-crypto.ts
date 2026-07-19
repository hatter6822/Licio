// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Local draft encryption (WS-C.2.2c, SPEC §6.8 "local encryption of drafts").
// Composer drafts are encrypted AT REST with AES-256-GCM so plaintext never sits
// in the draft store, in a SEPARATE key store (`licio-keys`) from the ciphertext.
//
// The key is a NON-EXTRACTABLE CryptoKey persisted DIRECTLY in IndexedDB (browsers
// structured-clone CryptoKeys): its raw bytes are never serialized, exportable, or
// at rest in any readable form — `exportKey` rejects, and there is no JWK to dump.
// So a casual inspection, a shared device, a partial/blob-level disk leak, or an
// other-origin storage bug yields ciphertext + an opaque, non-exfiltratable key.
// (The key never reaches the network; the decrypted payload is shape-validated.)
// Same-origin script can of course still *use* the key to decrypt in-page — that is
// inherent to ANY transparent client-side encryption, not a property of this design.
//
// Everything is best-effort: where Web Crypto is unavailable the caller falls back
// to plaintext so a draft is never lost (availability > confidentiality, §6.9
// "never silently lose a queued contribution").
import { z } from 'zod';

const KEY_DB = 'licio-keys';
const KEY_STORE = 'keys';
const KEY_ID = 'draft-aes-gcm';

/** The decrypted draft shape — validated at the trust boundary on decrypt. */
const draftValuesSchema = z.record(z.string(), z.string());

export interface DraftCipher {
  /** Base64 AES-GCM initialisation vector (96-bit, unique per encryption). */
  iv: string;
  /** Base64 ciphertext (includes the GCM auth tag). */
  data: string;
}

interface StoredKey {
  id: string;
  /** The non-extractable AES-GCM key itself (structured-cloned by IndexedDB). */
  key: CryptoKey;
}

function cryptoUnavailable(): boolean {
  return (
    typeof indexedDB === 'undefined' ||
    typeof crypto === 'undefined' ||
    typeof crypto.subtle === 'undefined'
  );
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function openKeyDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(KEY_DB, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(KEY_STORE, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('key store open failed'));
  });
}

function idbRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('key store request failed'));
  });
}

async function loadOrCreateKey(): Promise<CryptoKey | null> {
  if (cryptoUnavailable()) return null;
  const db = await openKeyDb().catch(() => null);
  if (!db) return null;
  try {
    const existing = await idbRequest<StoredKey | undefined>(
      db.transaction(KEY_STORE, 'readonly').objectStore(KEY_STORE).get(KEY_ID),
    );
    if (existing?.key instanceof CryptoKey) return existing.key;
    // NON-EXTRACTABLE (false): the raw key bytes can never be exported, and the
    // CryptoKey is persisted directly — no JWK/serialized key material at rest.
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt',
    ]);
    // First-run persistence is a check-then-act race across tabs: two tabs both
    // read no key, both generate, and a `put` (upsert) lets the second overwrite
    // the first — the losing tab's already-encrypted drafts become permanently
    // undecryptable after reload. `add` is insert-ONLY: exactly one tab wins the
    // (id) uniqueness constraint; every other tab's `add` throws, and it re-reads
    // the winner so all tabs converge on ONE key before encrypting anything.
    try {
      await idbRequest(
        db.transaction(KEY_STORE, 'readwrite').objectStore(KEY_STORE).add({ id: KEY_ID, key }),
      );
      return key;
    } catch {
      const winner = await idbRequest<StoredKey | undefined>(
        db.transaction(KEY_STORE, 'readonly').objectStore(KEY_STORE).get(KEY_ID),
      );
      return winner?.key instanceof CryptoKey ? winner.key : null;
    }
  } catch {
    return null;
  } finally {
    // Don't hold the key-store connection open (it would block deletes/upgrades).
    db.close();
  }
}

let keyPromise: Promise<CryptoKey | null> | null = null;

function getKey(): Promise<CryptoKey | null> {
  if (!keyPromise) {
    // Cache only a SUCCESSFUL key handle. A transient failure (key-store open
    // race, quota, aborted tx) must not permanently memoize `null` — that would
    // silently downgrade every draft this session to plaintext. Clear the cache
    // on null so the next saveDraft retries acquisition.
    keyPromise = loadOrCreateKey().then((key) => {
      if (!key) keyPromise = null;
      return key;
    });
  }
  return keyPromise;
}

/** Drop the cached key handle (tests / after a key-store reset). */
export function resetDraftKeyCache(): void {
  keyPromise = null;
}

/** Encrypt draft values; null when Web Crypto is unavailable (caller falls back). */
export async function encryptDraftValues(
  values: Record<string, string>,
): Promise<DraftCipher | null> {
  const key = await getKey();
  if (!key) return null;
  try {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = new TextEncoder().encode(JSON.stringify(values));
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
    return { iv: bytesToBase64(iv), data: bytesToBase64(new Uint8Array(ciphertext)) };
  } catch {
    return null;
  }
}

/** Decrypt + validate draft values; null on tamper, wrong key, or unavailability. */
export async function decryptDraftValues(
  cipher: DraftCipher,
): Promise<Record<string, string> | null> {
  const key = await getKey();
  if (!key) return null;
  try {
    const iv = base64ToBytes(cipher.iv);
    const data = base64ToBytes(cipher.data);
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
    const parsed: unknown = JSON.parse(new TextDecoder().decode(plaintext));
    return draftValuesSchema.parse(parsed);
  } catch {
    // GCM auth-tag failure (tamper/wrong key), malformed JSON, or wrong shape.
    return null;
  }
}
