// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-K observability counters (the per-workstream metrics pattern). Every WS-K
// "emit X" in the planning doc is a counter here + a structured `log(event,
// meta)` line + (where the doc requires it) an immutable audit/record row. No
// model payloads or user content ever reach a metric label.
export class AiGovernanceMetrics {
  readonly #counters = new Map<string, number>();
  readonly #gauges = new Map<string, number>();

  increment(name: string, by = 1): void {
    this.#counters.set(name, (this.#counters.get(name) ?? 0) + by);
  }

  counter(name: string): number {
    return this.#counters.get(name) ?? 0;
  }

  gauge(name: string, value: number): void {
    this.#gauges.set(name, value);
  }

  snapshot(): { counters: Record<string, number>; gauges: Record<string, number> } {
    return {
      counters: Object.fromEntries(this.#counters),
      gauges: Object.fromEntries(this.#gauges),
    };
  }

  clear(): void {
    this.#counters.clear();
    this.#gauges.clear();
  }
}
