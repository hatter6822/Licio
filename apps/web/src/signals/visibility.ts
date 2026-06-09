// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Active-viewing detection (WS-C.4.1a, SPEC §5.3/§19.2). Active viewing requires
// BOTH document visibility AND window focus. The AND is always derived from the
// CURRENT DOM truth on every event, not from assuming paired visibility/focus
// events fire together (some browsers fire one without the other). A bfcache
// resume (`pageshow`) re-derives correctly. This module produces no telemetry of
// its own — only an `active` boolean others consume.
export interface VisibilityReaders {
  isVisible: () => boolean;
  isFocused: () => boolean;
}

const domReaders: VisibilityReaders = {
  isVisible: () => typeof document === 'undefined' || document.visibilityState === 'visible',
  isFocused: () =>
    typeof document === 'undefined' || typeof document.hasFocus !== 'function'
      ? true
      : document.hasFocus(),
};

export class EngagementTracker {
  private active: boolean;
  private readonly listeners = new Set<(active: boolean) => void>();

  constructor(private readonly readers: VisibilityReaders = domReaders) {
    this.active = this.readers.isVisible() && this.readers.isFocused();
  }

  get isActive(): boolean {
    return this.active;
  }

  subscribe(listener: (active: boolean) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Re-derive `active` from current visibility+focus and notify on change. */
  refresh(): void {
    const next = this.readers.isVisible() && this.readers.isFocused();
    if (next === this.active) return;
    this.active = next;
    for (const listener of this.listeners) listener(next);
  }

  /** Wire DOM listeners (visibility, focus, blur, bfcache). Returns teardown. */
  start(): () => void {
    if (typeof document === 'undefined' || typeof window === 'undefined') {
      return () => undefined;
    }
    const onChange = (): void => this.refresh();
    document.addEventListener('visibilitychange', onChange);
    window.addEventListener('focus', onChange);
    window.addEventListener('blur', onChange);
    window.addEventListener('pageshow', onChange);
    return () => {
      document.removeEventListener('visibilitychange', onChange);
      window.removeEventListener('focus', onChange);
      window.removeEventListener('blur', onChange);
      window.removeEventListener('pageshow', onChange);
    };
  }
}
