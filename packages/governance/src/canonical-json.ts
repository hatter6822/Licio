// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Deterministic canonical JSON for content-addressing a GovernancePolicyBundle,
// prompt, or law-pack (SPEC §16.6). Recursively sorts object keys so the digest
// the caller computes (`sha256(canonicalize(x))`) is stable across runs and
// hosts — the hash-pin members verify against the downloadable artifact.

function toCanonical(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(toCanonical);
  const obj = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = toCanonical(obj[key]);
  }
  return sorted;
}

/** Canonical (key-sorted) JSON string for digesting. */
export function canonicalize(value: unknown): string {
  return JSON.stringify(toCanonical(value));
}
