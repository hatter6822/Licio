// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Deterministic canonical JSON (WS-K.1.1f config hashing). Serializes a value
// with object keys sorted recursively so the SAME configuration always produces
// the SAME string — the stable input the API layer hashes (SHA-256) into an
// `AIOutputRecord.config_hash`. Browser-safe (no node:crypto); the hash itself
// is computed server-side where the audit fingerprint matters.
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** Recursively sort object keys; arrays keep order; primitives pass through. */
function canonicalize(value: unknown): Json {
  if (value === null || typeof value !== 'object') {
    // undefined and non-finite numbers are not representable — normalize them
    // to null so the serialization is total and deterministic.
    if (value === undefined) return null;
    if (typeof value === 'number' && !Number.isFinite(value)) return null;
    return value as Json;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  const out: { [key: string]: Json } = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = canonicalize((value as Record<string, unknown>)[key]);
  }
  return out;
}

/** A canonical, key-sorted JSON string for `value`. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}
