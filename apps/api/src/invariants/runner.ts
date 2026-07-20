// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-H.1.2c/f/g — the fallback execution wrapper, tier orchestration
// primitives, and uniform health metrics.
//
// Every invariant call goes through `runGuarded`: a configurable timeout +
// try/catch that, on ANY failure (error, timeout, insufficient data),
// returns a DEGRADED envelope with the correct reason code and emits a gap
// record (structured log + metrics counter + run-metadata row — the
// dashboard/alerting feed, WS-H.1.2c-2). Ranking consumers treat degraded
// envelopes as ABSENT features — never a zero score — and no invariant
// failure can block the caller (verified by the all-invariants-failing
// test). Batch work runs through a bounded-concurrency mapper so the batch
// tier cannot starve real-time computation (WS-H.1.2f back-pressure).

import {
  degradedEnvelope,
  type InvariantComputation,
  type InvariantTarget,
  type InvariantTimeWindow,
  validateScoreVector,
} from '@licio/invariants';
import type { InvariantOutputRecord, InvariantOutputStore } from '../events/stores.js';
import type { RunMetadataStore } from './stores.js';

export interface GapEvent {
  invariantType: string;
  targetId: string | null;
  failureReason: string;
  timestamp: string;
  fallbackUsed: boolean;
  reasonCodes: string[];
}

export interface RunnerDeps {
  runMetadata: RunMetadataStore;
  metrics: { increment(name: string, by?: number): void };
  log: (event: string, meta: Record<string, unknown>) => void;
  now: () => number;
}

/** Per-invariant rolling health (WS-H.1.2g; feeds getHealthMetrics). */
export class HealthRecorder {
  readonly #latencies: number[] = [];
  #errorCount = 0;
  #fallbackCount = 0;
  #outputCount = 0;
  #coverageSum = 0;
  #confidenceSum = 0;
  #lastSuccessAt: string | null = null;

  observe(
    latencyMs: number,
    outputs: readonly { coverage: number; confidence: number; fallback_used: boolean }[],
  ): void {
    this.#latencies.push(latencyMs);
    if (this.#latencies.length > 1_000) this.#latencies.shift();
    for (const output of outputs) {
      this.#outputCount += 1;
      this.#coverageSum += output.coverage;
      this.#confidenceSum += output.confidence;
      if (output.fallback_used) this.#fallbackCount += 1;
    }
    this.#lastSuccessAt = new Date().toISOString();
  }

  observeError(): void {
    this.#errorCount += 1;
  }

  snapshot(): {
    latencyMsP50: number;
    latencyMsP99: number;
    errorCount: number;
    coverageRatio: number;
    confidenceRatio: number;
    fallbackRate: number;
    outputCount: number;
    lastSuccessAt: string | null;
  } {
    const sorted = [...this.#latencies].sort((a, b) => a - b);
    const pick = (q: number): number =>
      sorted.length === 0
        ? 0
        : (sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0);
    return {
      latencyMsP50: pick(0.5),
      latencyMsP99: pick(0.99),
      errorCount: this.#errorCount,
      coverageRatio: this.#outputCount === 0 ? 0 : this.#coverageSum / this.#outputCount,
      confidenceRatio: this.#outputCount === 0 ? 0 : this.#confidenceSum / this.#outputCount,
      fallbackRate: this.#outputCount === 0 ? 0 : this.#fallbackCount / this.#outputCount,
      outputCount: this.#outputCount,
      lastSuccessAt: this.#lastSuccessAt,
    };
  }
}

/** A promise that rejects after `ms` (cooperative timeout). */
function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('TIMEOUT')), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/**
 * Run one invariant computation guarded (WS-H.1.2c). On failure the result
 * is `{ ok: false, degraded }` — the caller proceeds without this
 * invariant's contribution; the gap is logged and counted.
 */
export async function runGuarded(
  deps: RunnerDeps,
  invariantType: string,
  version: string,
  tier: 'realtime' | 'near_realtime' | 'batch',
  target: InvariantTarget | null,
  timeoutMs: number,
  work: () => Promise<InvariantComputation[]>,
): Promise<
  | { ok: true; outputs: InvariantComputation[]; durationMs: number }
  | { ok: false; degraded: ReturnType<typeof degradedEnvelope>; gap: GapEvent; durationMs: number }
> {
  const startedAtMs = deps.now();
  try {
    const outputs = await withTimeout(work(), timeoutMs);
    const durationMs = Math.max(0, deps.now() - startedAtMs);
    await deps.runMetadata.append({
      invariantType,
      tier,
      targetCount: outputs.length,
      durationMs,
      success: true,
      failureReason: null,
      startedAt: new Date(startedAtMs).toISOString(),
    });
    return { ok: true, outputs, durationMs };
  } catch (error) {
    const durationMs = Math.max(0, deps.now() - startedAtMs);
    const isTimeout = error instanceof Error && error.message === 'TIMEOUT';
    const reasonCodes = [isTimeout ? 'TIMEOUT' : 'COMPUTE_ERROR'];
    const failureReason = isTimeout
      ? 'TIMEOUT'
      : error instanceof Error
        ? error.constructor.name
        : 'unknown';
    const gap: GapEvent = {
      invariantType,
      targetId: target?.targetId ?? null,
      failureReason,
      timestamp: new Date(deps.now()).toISOString(),
      fallbackUsed: true,
      reasonCodes,
    };
    deps.metrics.increment(`invariants.gap.${invariantType}`);
    deps.log('invariants.gap', { ...gap });
    await deps.runMetadata.append({
      invariantType,
      tier,
      targetCount: 0,
      durationMs,
      success: false,
      failureReason,
      startedAt: new Date(startedAtMs).toISOString(),
    });
    return { ok: false, degraded: degradedEnvelope(version, reasonCodes), gap, durationMs };
  }
}

/**
 * Persist computations as shadow InvariantOutput rows, validating each
 * score vector against its per-type schema FIRST (WS-H.1.1d): an invalid
 * vector is rejected (logged, counted) and never lands.
 */
export async function persistComputations(
  store: InvariantOutputStore,
  deps: Pick<RunnerDeps, 'log' | 'metrics'>,
  computations: readonly InvariantComputation[],
  versionMetadata: Record<string, unknown> | null = null,
): Promise<number> {
  let written = 0;
  const nowIso = new Date().toISOString();
  for (const computation of computations) {
    const validation = validateScoreVector(computation.invariantType, computation.score_vector);
    if (!validation.ok) {
      deps.metrics.increment('invariants.score_vector_rejected');
      deps.log('invariants.score_vector_rejected', {
        invariant_type: computation.invariantType,
        problem: validation.problem,
      });
      continue;
    }
    await store.upsert({
      invariantType: computation.invariantType,
      targetType: computation.target.targetType,
      targetId: computation.target.targetId,
      timeWindow: computation.window,
      version: computation.version,
      scoreVector: computation.score_vector,
      explanationSummary: computation.explanationSummary,
      confidence: computation.confidence,
      coverage: computation.coverage,
      reasonCodes: computation.reason_codes,
      fallbackUsed: computation.fallback_used,
      versionMetadata,
      // EVERY WS-H output is shadow until the WS-H.1.2e promotion gate and
      // the M3 review lift it — and lifting changes effects, not this flag:
      // shadow rows stay historically marked.
      shadowMode: true,
      createdAt: nowIso,
    } satisfies InvariantOutputRecord);
    written += 1;
  }
  return written;
}

/** Bounded-concurrency map (WS-H.1.2f back-pressure for the batch tier). */
export async function mapBounded<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const lanes = Array.from(
    { length: Math.max(1, Math.min(concurrency, items.length)) },
    async () => {
      while (next < items.length) {
        const index = next;
        next += 1;
        const item = items[index];
        if (item === undefined) continue;
        results[index] = await worker(item);
      }
    },
  );
  await Promise.all(lanes);
  return results;
}

/** The canonical window used by hourly batch runs. */
export function hourWindow(nowMs: number): InvariantTimeWindow {
  const start = Math.floor(nowMs / 3_600_000) * 3_600_000;
  return {
    start: new Date(start).toISOString(),
    end: new Date(start + 3_600_000).toISOString(),
  };
}
