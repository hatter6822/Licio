// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Minimal in-process metrics for the event pipeline (WS-E.1.3a observability).
// Counters and a latency histogram, queryable in tests and loggable by the
// operator. Metric NAMES are closed (reason codes, never values): no attention
// value, bucket, or item identity ever appears in a name or label.

export class PipelineMetrics {
  readonly #counters = new Map<string, number>();
  readonly #latencies: number[] = [];

  increment(name: string, by = 1): void {
    this.#counters.set(name, (this.#counters.get(name) ?? 0) + by);
  }

  observeLatencyMs(ms: number): void {
    if (Number.isFinite(ms) && ms >= 0) this.#latencies.push(ms);
    // Bounded memory: keep the most recent 10k observations.
    if (this.#latencies.length > 10_000) this.#latencies.splice(0, this.#latencies.length - 10_000);
  }

  counter(name: string): number {
    return this.#counters.get(name) ?? 0;
  }

  snapshot(): {
    counters: Record<string, number>;
    latency: { count: number; p50: number; p99: number };
  } {
    const sorted = [...this.#latencies].sort((a, b) => a - b);
    const at = (q: number): number =>
      sorted.length === 0
        ? 0
        : (sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0);
    return {
      counters: Object.fromEntries(this.#counters),
      latency: { count: sorted.length, p50: at(0.5), p99: at(0.99) },
    };
  }

  clear(): void {
    this.#counters.clear();
    this.#latencies.length = 0;
  }
}
