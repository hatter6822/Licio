// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Scroll-cadence classifier (WS-C.4.1b, SPEC §5.3/§19.2). Distinguishes reading
// (steady, moderate velocity → full dwell), skimming (sustained high velocity →
// no dwell), and idle (no interaction past a threshold → no dwell). Scroll is
// sampled with a passive listener and throttled so the handler stays well under
// 1ms (no INP harm). A programmatic scroll (skip-link/route jump) is suppressed
// so it is not misread as skimming (WS-C.4.1b edge case). Only the resulting
// STATE is consumed downstream — no raw scroll stream is buffered or uploaded.
export type Cadence = 'reading' | 'skimming' | 'idle';

export interface CadenceConfig {
  /** Velocity above which scrolling reads as skimming, px/ms (default 2). */
  skimVelocityPxPerMs: number;
  /** No scroll for this long ⇒ idle (default 30s). Configurable (WS-C.4.1b). */
  idleMs: number;
  /** Throttle: ignore samples closer together than this (default 100ms). */
  sampleMs: number;
}

const DEFAULT_CONFIG: CadenceConfig = {
  skimVelocityPxPerMs: 2,
  idleMs: 30_000,
  sampleMs: 100,
};

export class CadenceTracker {
  private readonly config: CadenceConfig;
  private state: Cadence = 'idle';
  private lastPos = 0;
  private lastSampleAt = 0;
  private lastScrollAt = 0;
  private started = false;
  private suppressNext = false;
  private readonly listeners = new Set<(state: Cadence) => void>();

  constructor(config: Partial<CadenceConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  get cadence(): Cadence {
    return this.state;
  }

  subscribe(listener: (state: Cadence) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private setState(next: Cadence): void {
    if (next === this.state) return;
    this.state = next;
    for (const listener of this.listeners) listener(next);
  }

  /** Mark the next sample as programmatic so it is not classified as skimming. */
  markProgrammaticScroll(): void {
    this.suppressNext = true;
  }

  /**
   * Feed a scroll sample (position in px, monotonic time in ms). Throttled to
   * `sampleMs`. Classifies reading vs skimming by velocity; a suppressed
   * (programmatic) sample only updates bookkeeping.
   */
  sample(position: number, now: number): void {
    this.lastScrollAt = now;
    if (this.suppressNext) {
      this.suppressNext = false;
      this.lastPos = position;
      this.lastSampleAt = now;
      if (this.state === 'idle') this.setState('reading');
      return;
    }
    if (this.started && now - this.lastSampleAt < this.config.sampleMs) return;

    const dt = now - this.lastSampleAt;
    const velocity = dt > 0 && this.started ? Math.abs(position - this.lastPos) / dt : 0;
    this.lastPos = position;
    this.lastSampleAt = now;
    this.started = true;
    this.setState(velocity > this.config.skimVelocityPxPerMs ? 'skimming' : 'reading');
  }

  /** Transition to idle if no scroll has occurred for `idleMs`. */
  checkIdle(now: number): void {
    if (this.state !== 'idle' && now - this.lastScrollAt >= this.config.idleMs) {
      this.setState('idle');
    }
  }

  /** Wire a passive scroll listener + an idle poll. Returns teardown. */
  start(
    options: {
      target?: Window;
      intervalMs?: number;
      now?: () => number;
      position?: () => number;
    } = {},
  ): () => void {
    if (typeof window === 'undefined') return () => undefined;
    const target = options.target ?? window;
    const now = options.now ?? (() => performance.now());
    const position = options.position ?? (() => target.scrollY);
    const onScroll = (): void => this.sample(position(), now());
    target.addEventListener('scroll', onScroll, { passive: true });
    const interval = setInterval(() => this.checkIdle(now()), options.intervalMs ?? 1_000);
    if (typeof interval === 'object' && 'unref' in interval) {
      (interval as { unref: () => void }).unref();
    }
    return () => {
      target.removeEventListener('scroll', onScroll);
      clearInterval(interval);
    };
  }
}
