// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.3 — the bridge from a zod-validated record object to its canonical bytes.
// Several crypto operations (the §10.7 envelope signing input, the §10.3 invite
// plaintext) must turn a validated, string-keyed record into the ONE canonical
// DAG-CBOR byte string.  `canonicalizeRecord` builds a `CanonicalObject` from
// the record's own enumerable keys (omitting `undefined`, the optional-omit
// rule) and encodes it.  `canonical(...)` recurses into nested plain objects and
// fails closed on any exotic value, so this cannot smuggle a non-canonical field
// past a signature or a CID.

import { type CanonicalObject, type CanonicalValue, canonical } from './canonical.js';

/** Convert a validated record's own enumerable keys into a `CanonicalObject`. */
export function toCanonicalObject(record: object): CanonicalObject {
  const obj: Record<string, CanonicalValue> = {};
  for (const [key, value] of Object.entries(record)) {
    if (value === undefined) continue; // optional-omit (never null-fill)
    obj[key] = value as CanonicalValue;
  }
  return obj as CanonicalObject;
}

/** Canonical-encode a validated record object to its single byte representation. */
export function canonicalizeRecord(record: object): Uint8Array {
  return canonical(toCanonicalObject(record));
}
