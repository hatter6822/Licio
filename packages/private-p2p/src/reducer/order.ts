// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.5.4a — the Lamport clock + the §14.3.2 canonical total order.  Accepted
// ops are sorted ascending by `(lamport, created_at_bucket, author_device_id,
// op_id)`.  Because every op's `lamport` is strictly greater than every parent's
// (§14.3.1), this single sort already respects causality; the other three
// components break ties between truly-concurrent ops and are fully determined by
// op content, so every device derives the IDENTICAL sequence (§14.3.3).
//
// `lamport` is a non-negative DECIMAL STRING (exact beyond 2^53).  It is compared
// as a big integer WITHOUT BigInt parsing: a canonical no-leading-zero decimal
// string sorts numerically by (length, then lexicographic).  The three string
// tiebreakers are compared BYTEWISE over their UTF-8 encoding (the same rule the
// canonical profile uses for map keys), so the order is charset-independent.

import { compareBytes } from '../crypto/canonical.js';
import type { PrivateRoomOp } from '../schemas/ops.js';

const TEXT_ENCODER = new TextEncoder();

/**
 * Compare two canonical non-negative decimal strings as integers.  No leading
 * zeros (the `lamportSchema` invariant) ⇒ the longer string is the larger number,
 * and equal-length strings compare lexicographically.  No BigInt needed.
 */
export function compareDecimalStrings(a: string, b: string): number {
  if (a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Bytewise (UTF-8) string comparison — charset-independent and device-stable. */
function compareUtf8(a: string, b: string): number {
  return compareBytes(TEXT_ENCODER.encode(a), TEXT_ENCODER.encode(b));
}

/**
 * The §14.3.2 canonical total order over `(lamport, created_at_bucket,
 * author_device_id, op_id)`.  Returns a NEW array (input untouched); the result
 * is identical regardless of input order.
 */
export function canonicalOpOrder(ops: readonly PrivateRoomOp[]): PrivateRoomOp[] {
  return ops.slice().sort((a, b) => {
    const byLamport = compareDecimalStrings(a.lamport, b.lamport);
    if (byLamport !== 0) return byLamport;
    const byBucket = compareUtf8(a.created_at_bucket, b.created_at_bucket);
    if (byBucket !== 0) return byBucket;
    const byDevice = compareUtf8(a.author_device_id, b.author_device_id);
    if (byDevice !== 0) return byDevice;
    return compareUtf8(a.op_id, b.op_id);
  });
}

/**
 * §14.3.1 — an op's `lamport` MUST be strictly greater than every parent's
 * `lamport` (a linear extension of causality).  `parentLamports` are the parents'
 * lamport strings (the caller resolves them from the accepted set).
 */
export function lamportRespectsCausality(
  opLamport: string,
  parentLamports: readonly string[],
): boolean {
  for (const parent of parentLamports) {
    if (compareDecimalStrings(opLamport, parent) <= 0) return false;
  }
  return true;
}

/**
 * Compute the `lamport` for a NEW op: `1 + max(parents ∪ local_lamport)`
 * (§14.3.1), returned as a canonical decimal string.  Uses BigInt internally
 * (exact for arbitrarily large clocks) and emits no leading zeros.
 */
export function nextLamport(parentLamports: readonly string[], localLamport: string): string {
  let max = BigInt(localLamport);
  for (const parent of parentLamports) {
    const value = BigInt(parent);
    if (value > max) max = value;
  }
  return (max + 1n).toString(10);
}
