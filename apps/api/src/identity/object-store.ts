// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Object storage for DSAR export archives (WS-D.2.2c).  The archive is encrypted
// at rest (AES-256-GCM via the SecretBox) and fetched through a time-limited,
// HMAC-signed URL token — so a download requires BOTH a valid session+step-up AND
// an unforgeable signature that expires.  The in-memory implementation is the
// CI/dev adapter; an S3+KMS adapter implements the same interface in production.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { deriveKey, KEY_DOMAINS } from './crypto.js';
import type { SecretBox } from './secrets.js';

export interface StoredObject {
  /** Sealed (AES-256-GCM) ciphertext token — never plaintext at rest. */
  sealed: string;
  contentType: string;
  expiresAt: number;
}

export interface ObjectStore {
  put(key: string, plaintext: string, contentType: string, expiresAt: number): Promise<void>;
  /**
   * Fetch and decrypt an object.  Returns null for a missing OR EXPIRED object —
   * expiry is enforced at read time, so the 72-hour bound holds even if the
   * background sweeper has not yet removed the object (defense in depth; the
   * production S3 adapter mirrors this with a lifecycle rule + read-time check).
   */
  get(key: string, now?: number): Promise<{ bytes: Buffer; contentType: string } | null>;
  delete(key: string): Promise<void>;
  /** Keys whose `expiresAt` is at or before `now` (the sweeper's work list). */
  expiredKeys(now: number): Promise<string[]>;
  clear(): Promise<void>;
}

/** In-memory, encrypted-at-rest object store (CI/dev). */
export class InMemoryObjectStore implements ObjectStore {
  readonly #map = new Map<string, StoredObject>();
  readonly #box: SecretBox;

  constructor(box: SecretBox) {
    this.#box = box;
  }

  async put(key: string, plaintext: string, contentType: string, expiresAt: number): Promise<void> {
    this.#map.set(key, { sealed: this.#box.seal(plaintext), contentType, expiresAt });
  }

  async get(
    key: string,
    now: number = Date.now(),
  ): Promise<{ bytes: Buffer; contentType: string } | null> {
    const obj = this.#map.get(key);
    if (!obj) return null;
    if (obj.expiresAt <= now) {
      this.#map.delete(key);
      return null;
    }
    return { bytes: this.#box.open(obj.sealed), contentType: obj.contentType };
  }

  async delete(key: string): Promise<void> {
    this.#map.delete(key);
  }

  async expiredKeys(now: number): Promise<string[]> {
    return [...this.#map.entries()].filter(([, o]) => o.expiresAt <= now).map(([k]) => k);
  }

  async clear(): Promise<void> {
    this.#map.clear();
  }
}

// ---------------------------------------------------------------------------
// Signed download tokens.  A token binds {jobId, userId, expiry} under an HMAC
// key derived from the master secret in its OWN key domain (never shared with
// session refs or any other purpose); the download route recomputes and
// constant-time-compares it, so a token cannot be forged, rebound to another
// job/user, or used past expiry.
// ---------------------------------------------------------------------------

export const EXPORT_DOWNLOAD_TTL_MS = 72 * 60 * 60_000; // 72 hours

function signaturePayload(jobId: string, userId: string, expiresAt: number): string {
  // jobId/userId are UUIDs (fixed 36-char, dash-only) so the '.' separators are
  // unambiguous — no two distinct triples serialize to the same payload.
  return `${jobId}.${userId}.${expiresAt}`;
}

export function mintDownloadToken(
  masterSecret: string,
  jobId: string,
  userId: string,
  expiresAt: number,
): string {
  const key = deriveKey(masterSecret, KEY_DOMAINS.downloadToken);
  const sig = createHmac('sha256', key)
    .update(signaturePayload(jobId, userId, expiresAt))
    .digest('hex');
  return `${expiresAt}.${sig}`;
}

export function verifyDownloadToken(
  masterSecret: string,
  token: string,
  jobId: string,
  userId: string,
  now: number,
): boolean {
  const parts = token.split('.');
  // Exactly `expiry.signature` — a token with extra segments is malformed, not
  // leniently accepted (strict canonical form).
  if (parts.length !== 2) return false;
  const [expiresRaw, sig] = parts as [string, string];
  if (!/^\d{1,15}$/.test(expiresRaw) || sig.length === 0) return false;
  const expiresAt = Number(expiresRaw);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) return false;
  const expected = mintDownloadToken(masterSecret, jobId, userId, expiresAt).split(
    '.',
  )[1] as string;
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
