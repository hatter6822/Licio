// SPDX-License-Identifier: AGPL-3.0-or-later
//
// HyperLogLog (WS-E.3.2): bounded-memory distinct counting for the real-time
// aggregation layer. Standard HLL with m = 2^14 = 16384 one-byte registers
// (16 KiB per counter), the Flajolet et al. bias-corrected estimator, and
// linear-counting small-range correction. With a 64-bit hash the classic
// large-range correction is unnecessary at our cardinalities.
//
// Documented error bound (WS-E.3.2 acceptance): the standard error is
//   1.04 / sqrt(m) = 1.04 / 128 ≈ 0.81%,
// so reconciliation against the exact PostgreSQL aggregation tolerates
// ~3σ ≈ 2.4% (see reconcileRealtime). Hashing uses SHA-256 (node:crypto):
// deterministic, well distributed, dependency-free. The production Redis
// adapter uses native PFADD/PFCOUNT, which implements the same algorithm.
import { createHash } from 'node:crypto';

const REGISTER_BITS = 14;
const M = 1 << REGISTER_BITS; // 16384 registers
// Bias-correction constant for m >= 128: alpha_m = 0.7213 / (1 + 1.079 / m).
const ALPHA_M = 0.7213 / (1 + 1.079 / M);

/** The relative standard error of this HLL configuration (~0.81%). */
export const HLL_STANDARD_ERROR = 1.04 / Math.sqrt(M);

export class HyperLogLog {
  readonly #registers = new Uint8Array(M);

  /** Add an element (idempotent: re-adding never changes the estimate). */
  add(value: string): void {
    const digest = createHash('sha256').update(value).digest();
    // First 8 bytes as an unsigned 64-bit integer.
    const hash = digest.readBigUInt64BE(0);
    const index = Number(hash >> BigInt(64 - REGISTER_BITS));
    // Rank = position of the leftmost 1-bit in the remaining 50 bits (1-based);
    // an all-zero remainder yields the maximum rank 51.
    const remainder = hash & ((1n << BigInt(64 - REGISTER_BITS)) - 1n);
    let rank = 1;
    let probe = 1n << BigInt(64 - REGISTER_BITS - 1);
    while (probe > 0n && (remainder & probe) === 0n) {
      rank += 1;
      probe >>= 1n;
    }
    const current = this.#registers[index] ?? 0;
    if (rank > current) this.#registers[index] = rank;
  }

  /** The cardinality estimate (bias-corrected, small-range corrected). */
  estimate(): number {
    let sum = 0;
    let zeros = 0;
    for (let i = 0; i < M; i += 1) {
      const register = this.#registers[i] ?? 0;
      sum += 2 ** -register;
      if (register === 0) zeros += 1;
    }
    const raw = (ALPHA_M * M * M) / sum;
    // Small-range correction: linear counting while any register is empty and
    // the raw estimate is below 2.5m.
    if (raw <= 2.5 * M && zeros > 0) {
      return Math.round(M * Math.log(M / zeros));
    }
    return Math.round(raw);
  }
}
