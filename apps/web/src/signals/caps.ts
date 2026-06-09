// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Per-item dwell cap (WS-C.4.1c, SPEC §5.3). No single story can generate
// unbounded attention: once an item's counted dwell reaches the cap in a
// session, further dwell is not counted. This bounds gaming (a tab left open,
// obsessive re-reading) AND bounds how much a single item reveals about the
// reader (privacy). The cap is per item PER SESSION and resets between sessions.
import { DWELL_BUCKET_BOUNDARIES_MS } from '@licio/shared';

/**
 * Default cap (5 minutes) — the upper boundary of the `long` dwell bucket, so a
 * capped item lands in `extended` exactly when it reaches the cap. Server may
 * override.
 */
export const DEFAULT_DWELL_CAP_MS = DWELL_BUCKET_BOUNDARIES_MS[3];

export class DwellCapTracker {
  /** itemId → counted (capped) dwell this session. */
  private readonly counted = new Map<string, number>();

  constructor(private readonly capMs: number = DEFAULT_DWELL_CAP_MS) {}

  /**
   * Add `deltaMs` of dwell to an item, clamped so the item's counted total never
   * exceeds the cap. Returns the amount actually counted (0 once capped), so a
   * caller can tell when counting has stopped.
   */
  add(itemId: string, deltaMs: number): number {
    const current = this.counted.get(itemId) ?? 0;
    const next = Math.min(this.capMs, current + Math.max(0, deltaMs));
    this.counted.set(itemId, next);
    return next - current;
  }

  /** The item's counted (capped) dwell this session. */
  get(itemId: string): number {
    return this.counted.get(itemId) ?? 0;
  }

  /** Whether the item has reached its cap (surfaced as "counting stopped"). */
  isCapped(itemId: string): boolean {
    return (this.counted.get(itemId) ?? 0) >= this.capMs;
  }

  /** New session ⇒ new cap allowance for every item. */
  resetSession(): void {
    this.counted.clear();
  }
}
