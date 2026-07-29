// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Deterministic canonical JSON — ONE walker, two named policies.
//
// The repository had FIVE hand-rolled copies of "sort the keys at every depth
// and stringify": `@licio/governance` `canonicalize` (governance bundle, charter
// and hash-chain digests), `@licio/ai-governance` `canonicalJson` (the
// `AIOutputRecord.config_hash`), a private copy in `apps/api`'s Knomosis receipt
// comparison, a `stableStringify` in the jurisdiction policy delta, and a
// VERBATIM inline copy in `apps/web/src/lib/governance-download.ts` whose own
// comment recorded that it must stay byte-identical to the server's — the copy
// that decides whether `sha256(downloaded bundle) === artifact_digest`, i.e.
// whether a member's offline verification of a governance model means anything.
// A comment is not a mechanism; the two are byte-identical here by construction.
//
// They did not all agree, and the disagreement is the interesting part: it is
// entirely about values JSON cannot represent (`undefined`, `NaN`, `Infinity`).
// That is a real choice with two right answers depending on the caller, so it is
// a NAMED policy rather than a bug to average out:
//
//   • `canonicalJson` — `undefined` properties are OMITTED, exactly as
//     `JSON.stringify` and a Postgres `jsonb` round-trip drop them. This is
//     required wherever a digest is RE-COMPUTED later from stored data: the
//     hash-chained treasury/compliance audit logs and the charter digest hash a
//     value in memory and re-verify it after it has been through `jsonb`, where
//     the undefined-valued key no longer exists. Emitting `null` for it would
//     make every such chain fail its own verification.
//
//   • `totalCanonicalJson` — `undefined` and non-finite numbers become `null`,
//     so the encoding is TOTAL: every input has a representable image. This is
//     what a config fingerprint wants, where the goal is that any two
//     configurations differing at all produce different bytes, and it is the
//     contract `@licio/ai-governance`'s tests already pinned.
//
// Both share the same key ordering and the same array handling, so the axis of
// variation is one line rather than five programs.
//
// Key order is `Array.prototype.sort()`'s default: ascending UTF-16 code-unit
// order. Stated because it is the property everything else rests on — it must
// not quietly become locale-aware (`localeCompare`), which is
// environment-dependent and would make a digest host-specific.

/** How a value JSON cannot represent is encoded. */
type HolePolicy = 'omit' | 'null';

function toCanonical(value: unknown, holes: HolePolicy): unknown {
  if (value === null || typeof value !== 'object') {
    if (holes === 'null') {
      if (value === undefined) return null;
      if (typeof value === 'number' && !Number.isFinite(value)) return null;
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((entry) => toCanonical(entry, holes));
  const obj = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = toCanonical(obj[key], holes);
  }
  return sorted;
}

/**
 * Canonical (recursively key-sorted, whitespace-free) JSON.
 *
 * `undefined` properties are omitted — the same value `JSON.stringify` and a
 * `jsonb` column produce — so a digest taken before storage still verifies after
 * a round-trip. Use this for anything hashed into a chain or published as a
 * content address.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(toCanonical(value, 'omit'));
}

/**
 * Canonical JSON with a TOTAL encoding: `undefined` and non-finite numbers
 * become `null` rather than vanishing.
 *
 * Use this for fingerprints of in-memory values that are never re-read from
 * storage — where "this key was present but unrepresentable" should be
 * distinguishable from "this key was absent".
 */
export function totalCanonicalJson(value: unknown): string {
  return JSON.stringify(toCanonical(value, 'null'));
}
