// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Shingling + MinHash + LSH banding (WS-F.1.3c, SPEC §14.2) — the pure math
// behind near-duplicate text detection, shared with the WS-H.2.1a MERI
// near-duplicate grouping (both reference the same technique by design).
//
// Construction. A text is normalized (casefold, collapse whitespace) and cut
// into character-level k-shingles (k = 5). Each shingle is hashed to a 32-bit
// integer (FNV-1a), then passed through 128 fixed universal-hash functions
//   hᵢ(x) = (aᵢ·x + bᵢ) mod p,   p = 4 294 967 311 (smallest prime > 2³²)
// evaluated in EXACT double arithmetic via `universalHashMod` (aᵢ·x can
// exceed 2⁵³, so a 16-bit split keeps every intermediate product < 2⁵³ and
// therefore exact — proven equivalent to a BigInt reference and pinned by a
// golden-signature test). The signature component i is min over all shingles
// of hᵢ(x). For random permutations, P[minᵢ(A) = minᵢ(B)] = J(A, B), so the
// fraction of agreeing components estimates the Jaccard similarity with
// standard error √(J(1−J)/128) ≤ 0.0442.
//
// The (aᵢ, bᵢ) family is generated from a FIXED seed (mulberry32) and frozen
// under MINHASH_FAMILY_VERSION: signatures are persisted and compared across
// runs and machines, so the family may never silently change — bump the
// version and re-signature instead.
//
// LSH banding. The 128 components are grouped into b = 32 bands of r = 4
// rows; two texts are LSH *candidates* when any band hashes identically.
//   P(candidate | J = s) = 1 − (1 − s^r)^b
// The WS-F.1.3c task sketch labels (b=32, r=4) "a ~0.7 crossover". Exactly:
// the curve's 50% point is s* = (1 − 2^(−1/b))^(1/r) ≈ 0.3826 and the
// conventional steep-point approximation (1/b)^(1/r) ≈ 0.4204 sits at
// P ≈ 0.636 — both WELL BELOW 0.7, which is precisely why this banding is
// the right RETRIEVAL choice for a 0.7 decision threshold: detection of true
// ≥ 0.7 pairs is near-certain, and the final flag decision is made by the
// signature ESTIMATE against the configurable threshold, not by the curve.
//   P(candidate | s = 0.70)  ≈ 0.999847   (retrieval recall at the threshold)
//   P(candidate | s = 0.50)  ≈ 0.873      (retrieved, then filtered by estimate)
//   P(candidate | s = 0.42)  ≈ 0.636
//   P(candidate | s = 0.3826)≈ 0.50       (exact crossover)
//   P(candidate | s = 0.30)  ≈ 0.229
//   P(candidate | s = 0.20)  ≈ 0.050
// Retrieval is O(b) band-bucket lookups against a persisted band index —
// sub-linear, never a pairwise scan (WS-F.1.3c acceptance).

/** Pinned parameters for persisted signatures (stored alongside each row). */
export const MINHASH_FAMILY_VERSION = 1;
export const MINHASH_SHINGLE_K = 5;
export const MINHASH_NUM_HASHES = 128;
export const MINHASH_LSH_BANDS = 32;
export const MINHASH_LSH_ROWS = 4;

// Runtime-checked at module load: bands × rows must cover the full signature.
if (MINHASH_LSH_BANDS * MINHASH_LSH_ROWS !== MINHASH_NUM_HASHES) {
  throw new Error(
    `MinHash LSH banding must cover the signature: ${MINHASH_LSH_BANDS} bands × ${MINHASH_LSH_ROWS} rows !== ${MINHASH_NUM_HASHES} hashes`,
  );
}

/** Smallest prime greater than 2³² (universal-hash modulus). */
const PRIME_NUMBER = 4_294_967_311;

/** mulberry32 — duplicated minimally here (the test harness copy lives under
 *  __tests__ and must not be imported by production code). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The fixed (aᵢ, bᵢ) universal-hash family for MINHASH_FAMILY_VERSION = 1,
 * stored as plain Numbers. The (aᵢ, bᵢ) values are at most p − 1 ≈ 2³² + 14,
 * well within the 2⁵³ exact-integer range, so the Number family is identical
 * to the prior BigInt family value-for-value (golden-signature regression
 * test pins the resulting output, so persisted signatures cannot drift).
 */
const HASH_FAMILY_A = new Float64Array(MINHASH_NUM_HASHES);
const HASH_FAMILY_B = new Float64Array(MINHASH_NUM_HASHES);
(() => {
  const rng = mulberry32(0x5eed_f00d);
  for (let i = 0; i < MINHASH_NUM_HASHES; i += 1) {
    // a ∈ [1, p−1] (a ≠ 0 keeps the function injective mod p), b ∈ [0, p−1].
    HASH_FAMILY_A[i] = 1 + Math.floor(rng() * (PRIME_NUMBER - 1));
    HASH_FAMILY_B[i] = Math.floor(rng() * PRIME_NUMBER);
  }
})();

/**
 * `(a·x + b) mod p` in EXACT double arithmetic — no BigInt (the per-shingle,
 * per-hash inner loop is the hot path). Correctness: split x into 16-bit
 * halves so every product stays below 2⁵³ and is therefore exact —
 *   a·x = a·(xHi·2¹⁶ + xLo);  a·xHi, a·xLo < (2³²+15)·2¹⁶ ≈ 2⁴⁸
 * and `(a·xHi·2¹⁶ + a·xLo + b) mod p = ((a·xHi mod p)·2¹⁶ mod p
 *   + (a·xLo mod p) + b) mod p`, each term < p ≈ 2³² so the final sum < 3p < 2⁵³.
 * Algebraically identical to the BigInt form (property-tested against a
 * BigInt reference across the full uint32 range).
 */
export function universalHashMod(a: number, x: number, b: number): number {
  const xHi = x >>> 16;
  const xLo = x & 0xffff;
  let t1 = (a * xHi) % PRIME_NUMBER;
  t1 = (t1 * 65536) % PRIME_NUMBER;
  const t2 = (a * xLo) % PRIME_NUMBER;
  return (t1 + t2 + b) % PRIME_NUMBER;
}

/** FNV-1a 32-bit hash of a string (shingle → uint32). */
export function fnv1a32(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Casefold + collapse whitespace so cosmetic edits do not change shingles. */
export function normalizeForShingling(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * The SET of k-shingle hashes for a text (deduplicated — Jaccard is over
 * sets). Texts shorter than k yield a single whole-text shingle so trivial
 * inputs still produce a well-defined signature.
 */
export function shingleHashes(text: string, k: number = MINHASH_SHINGLE_K): Set<number> {
  const normalized = normalizeForShingling(text);
  const hashes = new Set<number>();
  if (normalized.length === 0) return hashes;
  if (normalized.length <= k) {
    hashes.add(fnv1a32(normalized));
    return hashes;
  }
  for (let i = 0; i + k <= normalized.length; i += 1) {
    hashes.add(fnv1a32(normalized.slice(i, i + k)));
  }
  return hashes;
}

/**
 * The 128-component MinHash signature of a text. Empty text yields an
 * all-sentinel signature (p − 1 as uint32 saturate: 0xffffffff) that never
 * spuriously matches real content.
 */
export function minhashSignature(text: string): Uint32Array {
  const shingles = shingleHashes(text);
  const signature = new Uint32Array(MINHASH_NUM_HASHES).fill(0xffffffff);
  if (shingles.size === 0) return signature;
  for (const shingle of shingles) {
    for (let i = 0; i < MINHASH_NUM_HASHES; i += 1) {
      const value = universalHashMod(
        HASH_FAMILY_A[i] as number,
        shingle,
        HASH_FAMILY_B[i] as number,
      );
      // Saturate to uint32 for storage (p − 1 barely exceeds 2³² − 1; the
      // clamp affects ~15/2³² of the range and is identical for both sides
      // of any comparison, so the estimator is unaffected).
      const clamped = value > 0xffffffff ? 0xffffffff : value;
      if (clamped < (signature[i] as number)) signature[i] = clamped;
    }
  }
  return signature;
}

/**
 * Estimated Jaccard similarity: the fraction of agreeing signature
 * components. Unbiased for ideal permutations; std-error ≤ 0.0442 at 128
 * hashes. Two empty-text sentinels estimate 1 by construction — callers
 * exclude empty texts before comparing (the ingestion service never
 * signatures an empty document).
 */
export function estimateJaccard(a: Uint32Array, b: Uint32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let matches = 0;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] === b[i]) matches += 1;
  }
  return matches / a.length;
}

/** Exact Jaccard over shingle sets (test oracle + small-corpus fallback). */
export function exactJaccard(textA: string, textB: string): number {
  const a = shingleHashes(textA);
  const b = shingleHashes(textB);
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const hash of a) {
    if (b.has(hash)) intersection += 1;
  }
  return intersection / (a.size + b.size - intersection);
}

/**
 * The b = 32 LSH band hashes of a signature: band i is the FNV-1a hash of its
 * r = 4 component values (prefixed with the band index so identical rows in
 * DIFFERENT bands never collide into one bucket key).
 */
export function lshBandHashes(signature: Uint32Array): Uint32Array {
  const bands = new Uint32Array(MINHASH_LSH_BANDS);
  for (let band = 0; band < MINHASH_LSH_BANDS; band += 1) {
    let hash = 0x811c9dc5;
    hash ^= band;
    hash = Math.imul(hash, 0x01000193);
    for (let row = 0; row < MINHASH_LSH_ROWS; row += 1) {
      const component = signature[band * MINHASH_LSH_ROWS + row] as number;
      // Mix the four bytes of the component.
      for (let shift = 0; shift < 32; shift += 8) {
        hash ^= (component >>> shift) & 0xff;
        hash = Math.imul(hash, 0x01000193);
      }
    }
    bands[band] = hash >>> 0;
  }
  return bands;
}

/** P(candidate | J = s) for the pinned (b, r) banding — the documented curve. */
export function lshCandidateProbability(similarity: number): number {
  const s = Math.min(1, Math.max(0, similarity));
  return 1 - (1 - s ** MINHASH_LSH_ROWS) ** MINHASH_LSH_BANDS;
}
