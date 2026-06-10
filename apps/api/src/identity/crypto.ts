// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Low-level identity crypto primitives (WS-D).  Every value that would otherwise
// sit in plaintext — session tokens, IP addresses, wallet addresses — is reduced
// here to a one-way hash before it touches durable storage.
//
// Domain separation: all keyed hashes derive a per-purpose subkey from a single
// master secret (SESSION_SECRET) via HKDF-SHA256 with a distinct `info` label, so
// the auth-wallet hash and the financial-wallet hash of the SAME address are
// non-correlatable (WS-D.1.4c / §19.5), and an IP hash key can never be confused
// with a wallet key.
import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

/** Distinct HKDF `info` labels — the domain-separation namespaces. */
export const KEY_DOMAINS = {
  ipHash: 'licio:ip-hash:v1',
  authWallet: 'licio:auth-wallet:v1',
  financialWallet: 'licio:financial-wallet:v1',
  sessionRef: 'licio:session-ref:v1',
  accountRef: 'licio:account-ref:v1',
} as const;
export type KeyDomain = (typeof KEY_DOMAINS)[keyof typeof KEY_DOMAINS];

// A fixed, non-secret salt for HKDF.  The secret is the IKM (SESSION_SECRET); the
// per-domain separation comes from `info`.  A constant salt is standard for HKDF
// when the IKM already has full entropy.
const HKDF_SALT = Buffer.from('licio-identity-hkdf-salt-v1', 'utf8');

/**
 * Derive a 32-byte domain-separated subkey from the master secret.  Two distinct
 * domains yield independent keys, so a hash under one domain reveals nothing about
 * the hash of the same input under another (the §19.5 separation guarantee).
 */
export function deriveKey(masterSecret: string, domain: KeyDomain): Buffer {
  const ikm = Buffer.from(masterSecret, 'utf8');
  return Buffer.from(hkdfSync('sha256', ikm, HKDF_SALT, Buffer.from(domain, 'utf8'), 32));
}

/** Lower-cased, hex SHA-256 of a string or buffer.  Used to hash session tokens. */
export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

/** Keyed HMAC-SHA256 (hex) under a derived subkey.  The one-way hash for IP/address. */
export function hmacHex(key: Buffer, input: string): string {
  return createHmac('sha256', key).update(input).digest('hex');
}

/** A cryptographically-random opaque token (hex).  Default 32 bytes (256 bits). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('hex');
}

/**
 * Constant-time equality for two hex strings.  Returns false on any length
 * mismatch WITHOUT a short-circuit that leaks length via timing of the compare
 * itself (length is compared first, but that is inherent and unavoidable; the
 * byte comparison is constant-time for equal-length inputs).
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * A non-reversible display reference for a session (WS-D.1.3c).  Derived from the
 * stored token hash; only a short prefix is shown, and it is keyed so it cannot be
 * correlated back to the hash by an observer.
 */
export function sessionRef(masterSecret: string, tokenHash: string): string {
  const key = deriveKey(masterSecret, KEY_DOMAINS.sessionRef);
  return hmacHex(key, tokenHash).slice(0, 12);
}

/**
 * A keyed, non-reversible reference for an account, used as a rate-limit / audit
 * key without storing the email or user id in the clear in those keyspaces.
 */
export function accountRef(masterSecret: string, identifier: string): string {
  const key = deriveKey(masterSecret, KEY_DOMAINS.accountRef);
  return hmacHex(key, identifier.toLowerCase());
}

/**
 * Truncate a hex address to a display form `0x12ab…cd34`.  Pure display — never a
 * security boundary.  Inputs shorter than the head+tail simply round-trip.
 */
export function truncateAddress(address: string): string {
  const a = address.trim();
  if (a.length <= 12) return a;
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}
