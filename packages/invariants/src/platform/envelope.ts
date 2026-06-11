// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-H.1.1c — envelope builders.
//
// Helpers producing well-formed `InvariantOutputEnvelope`s: the degraded
// envelope is what the fallback execution wrapper (WS-H.1.2c) emits when a
// computation fails, times out, or lacks coverage — an explicit,
// reason-coded "no usable signal" that ranking treats as ABSENT (features
// omitted), never as a zero score.

import { fallbackUsedFrom, validateReasonCodes } from '../schemas/reason-codes.js';
import type { InvariantOutputEnvelope } from '../types.js';

/** Build a validated envelope (throws on unknown reason codes). */
export function buildEnvelope(input: {
  scoreVector: Record<string, unknown>;
  confidence: number;
  coverage: number;
  reasonCodes: readonly string[];
  version: string;
}): InvariantOutputEnvelope {
  const unknown = validateReasonCodes(input.reasonCodes);
  if (unknown !== null) throw new Error(`unknown reason code '${unknown}'`);
  const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
  return {
    score_vector: input.scoreVector,
    confidence: clamp01(input.confidence),
    coverage: clamp01(input.coverage),
    reason_codes: [...input.reasonCodes],
    fallback_used: fallbackUsedFrom(input.reasonCodes),
    version: input.version,
  };
}

/**
 * The degraded envelope: zero confidence, explicit reason codes, an empty
 * score vector. Consumers MUST treat it as "no signal" — the wrapper and
 * the ranking boundary both enforce that (WS-H.1.2c).
 */
export function degradedEnvelope(
  version: string,
  reasonCodes: readonly string[],
  coverage = 0,
): InvariantOutputEnvelope {
  return buildEnvelope({
    scoreVector: {},
    confidence: 0,
    coverage,
    reasonCodes,
    version,
  });
}
