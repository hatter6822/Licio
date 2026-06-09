// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Active-dwell accumulator (WS-C.4.1a). Accumulates elapsed time ONLY while the
// reader is "engaged" (visible + focused + reading cadence — computed upstream).
// Uses a monotonic clock (performance.now) so a wall-clock change can never
// inflate dwell, and clamps every interval to ≥ 0 so a backward clock step
// contributes nothing (anti-gaming + correctness).

/** A monotonic millisecond clock. Injectable for deterministic tests. */
export type Clock = () => number;

const defaultClock: Clock = () =>
  typeof performance !== 'undefined' ? performance.now() : Date.now();

export class DwellAccumulator {
  private engaged = false;
  private accumulatedMs = 0;
  private lastAt: number;

  constructor(private readonly now: Clock = defaultClock) {
    this.lastAt = this.now();
  }

  /**
   * Set whether dwell is currently accruing. Closes the open interval (adding it
   * to the total only if it was engaged) and opens a new one at `now`.
   */
  setEngaged(engaged: boolean): void {
    const t = this.now();
    if (this.engaged) this.accumulatedMs += Math.max(0, t - this.lastAt);
    this.engaged = engaged;
    this.lastAt = t;
  }

  /** Total engaged milliseconds, including any currently-open engaged interval. */
  get ms(): number {
    const t = this.now();
    return this.accumulatedMs + (this.engaged ? Math.max(0, t - this.lastAt) : 0);
  }

  get isEngaged(): boolean {
    return this.engaged;
  }

  /** Reset to zero (e.g. at a session boundary). */
  reset(): void {
    this.engaged = false;
    this.accumulatedMs = 0;
    this.lastAt = this.now();
  }
}
