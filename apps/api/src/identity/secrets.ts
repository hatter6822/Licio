// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Authenticated encryption-at-rest for small secrets — specifically the steward
// TOTP secret (WS-D.1.5a), which must never be stored in plaintext.  This is real
// envelope encryption: AES-256-GCM under an HKDF-derived, domain-separated key
// (so the encryption key is distinct from every hashing key).  The sealed token
// is `v1.<iv>.<ciphertext>.<tag>` (base64url parts); GCM's tag makes tampering
// detectable (open throws).
//
// Production may swap a KMS-backed implementation behind the same `SecretBox`
// interface; the local box derives its key from SESSION_SECRET, so no plaintext
// key is ever stored.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { deriveKey, KEY_DOMAINS } from './crypto.js';

export interface SecretBox {
  /** Encrypt + authenticate; returns an opaque, self-describing token. */
  seal(plaintext: Uint8Array | string): string;
  /** Decrypt + verify; throws on tamper or wrong key. */
  open(sealed: string): Buffer;
}

const VERSION = 'v1';
const IV_BYTES = 12; // 96-bit nonce (GCM standard)

function b64url(buf: Uint8Array): string {
  return Buffer.from(buf).toString('base64url');
}

/** Build a local AES-256-GCM secret box keyed from the master secret. */
export function createLocalSecretBox(masterSecret: string): SecretBox {
  const key = deriveKey(masterSecret, KEY_DOMAINS.secretBox); // 32 bytes

  return {
    seal(plaintext: Uint8Array | string): string {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const data =
        typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : Buffer.from(plaintext);
      const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
      const tag = cipher.getAuthTag();
      return `${VERSION}.${b64url(iv)}.${b64url(ciphertext)}.${b64url(tag)}`;
    },

    open(sealed: string): Buffer {
      const parts = sealed.split('.');
      if (parts.length !== 4 || parts[0] !== VERSION) {
        throw new Error('secret-box: malformed token');
      }
      const iv = Buffer.from(parts[1] as string, 'base64url');
      const ciphertext = Buffer.from(parts[2] as string, 'base64url');
      const tag = Buffer.from(parts[3] as string, 'base64url');
      if (iv.length !== IV_BYTES) throw new Error('secret-box: bad iv');
      // Enforce the full 128-bit GCM tag: a truncated tag drops forgery
      // resistance from 2^128 to 2^(8·len).  Reject before setAuthTag, and pass
      // authTagLength so Node itself rejects a non-16-byte tag (and DEP0182 stays quiet).
      if (tag.length !== 16) throw new Error('secret-box: bad tag');
      const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    },
  };
}
