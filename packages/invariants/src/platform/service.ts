// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-H.1.2a — the InvariantService interface every invariant implements,
// plus the compute-tier vocabulary (WS-H.1.2f) and health metrics shape.
//
// The interface is deliberately I/O-shaped (Promise-returning) so server
// implementations can read their stores, while the mathematics stays in
// the pure modules of this package. `computeBatch` serves audits and
// backfills; `computeRealtime` is the cheap approximation tier with a
// latency budget the platform wrapper enforces; `getCard` returns the
// WS-H.1.2b card; `getHealthMetrics` feeds the uniform observability
// surface (WS-H.1.2g).

import type { InvariantCard } from '../schemas/card.js';
import type {
  InvariantOutputEnvelope,
  InvariantTarget,
  InvariantTimeWindow,
  InvariantType,
} from '../types.js';

export const COMPUTE_TIERS = ['realtime', 'near_realtime', 'batch'] as const;
export type ComputeTier = (typeof COMPUTE_TIERS)[number];

/** A full computed output: envelope + addressing + explanation. */
export interface InvariantComputation extends InvariantOutputEnvelope {
  invariantType: InvariantType;
  target: InvariantTarget;
  window: InvariantTimeWindow;
  explanationSummary: string | null;
}

export interface HealthMetrics {
  latencyMsP50: number;
  latencyMsP99: number;
  errorCount: number;
  /** Mean coverage across recent outputs. */
  coverageRatio: number;
  /** Mean confidence across recent outputs (the WS-H.1.2e promotion evidence). */
  confidenceRatio: number;
  fallbackRate: number;
  outputCount: number;
  lastSuccessAt: string | null;
}

/** Which methods an invariant offers per tier (the scheduler routes by it). */
export interface TierDeclaration {
  realtime: boolean;
  nearRealtime: boolean;
  batch: boolean;
}

export interface InvariantService {
  readonly invariantType: InvariantType;
  readonly tiers: TierDeclaration;
  /** Batch computation for audits and backfills (parallel across targets). */
  computeBatch(
    targets: readonly InvariantTarget[],
    window: InvariantTimeWindow,
  ): Promise<InvariantComputation[]>;
  /** Near-real-time approximation for ranking integration. */
  computeRealtime(target: InvariantTarget): Promise<InvariantComputation>;
  getCard(): InvariantCard;
  getHealthMetrics(): HealthMetrics;
}

export function emptyHealthMetrics(): HealthMetrics {
  return {
    latencyMsP50: 0,
    latencyMsP99: 0,
    errorCount: 0,
    coverageRatio: 0,
    confidenceRatio: 0,
    fallbackRate: 0,
    outputCount: 0,
    lastSuccessAt: null,
  };
}
