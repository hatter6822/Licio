// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Deterministic canonical JSON for content-addressing a GovernancePolicyBundle,
// prompt, or law-pack (SPEC §16.6), and for the hash-chained treasury/compliance
// audit logs and the charter digest.
//
// The algorithm is `@licio/shared`'s `canonicalJson` — the `omit` hole policy,
// which is the one these callers require: a chain entry is hashed in memory and
// re-verified after the value has been through a `jsonb` column, so the
// encoding has to drop an `undefined` property exactly as that round-trip does.
// This module keeps the `canonicalize` name its ~5 call sites already use.
import { canonicalJson } from '@licio/shared';

/** Canonical (key-sorted) JSON string for digesting. */
export function canonicalize(value: unknown): string {
  return canonicalJson(value);
}
