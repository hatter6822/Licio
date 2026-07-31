// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Deterministic canonical JSON (WS-K.1.1f config hashing). Serializes a value
// with object keys sorted recursively so the SAME configuration always produces
// the SAME string — the stable input the API layer hashes (SHA-256) into an
// `AIOutputRecord.config_hash`. Browser-safe (no node:crypto); the hash itself
// is computed server-side where the audit fingerprint matters.
//
// The algorithm is `@licio/shared`'s `totalCanonicalJson` — the `null` hole
// policy, which is this module's own long-standing pinned contract
// (`{a: undefined, b: NaN, c: Infinity}` → `{"a":null,"b":null,"c":null}`). A
// config fingerprint is never re-derived from stored JSON, so unlike the
// governance digests it gains nothing from mirroring a `jsonb` round-trip and
// gains a total encoding by not doing so.
import { totalCanonicalJson } from '@licio/shared';

/** A canonical, key-sorted JSON string for `value`. */
export function canonicalJson(value: unknown): string {
  return totalCanonicalJson(value);
}
