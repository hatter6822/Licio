// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Source/context open tracker (WS-C.4.2, SPEC §5.3). Counts a source open or a
// context-card open at most ONCE per meaningful session per item — and only when
// the open persists for a minimum duration (anti-gaming: rapid open/close churn
// below the threshold counts as zero). Only the deduped booleans reach the
// aggregate; open/close churn never produces a stream of uploads. An external
// link open is still counted, but carries NO off-app browsing history (§19.2).
export type OpenKind = 'source' | 'context';

export interface OpenTrackerConfig {
  /** Minimum ms a source open must persist to count (default 3s). */
  sourceMinMs: number;
  /** Minimum ms a context open must persist to count (default 2s). */
  contextMinMs: number;
}

const DEFAULT_CONFIG: OpenTrackerConfig = { sourceMinMs: 3_000, contextMinMs: 2_000 };

interface ItemOpens {
  source: boolean;
  context: boolean;
}

interface PendingOpen {
  itemId: string;
  kind: OpenKind;
  openedAt: number;
}

export class OpenTracker {
  private readonly config: OpenTrackerConfig;
  private readonly opened = new Map<string, ItemOpens>();
  private readonly pending = new Map<string, PendingOpen>();

  constructor(config: Partial<OpenTrackerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** Record the start of an open. `openId` ties the later close to this open. */
  open(openId: string, itemId: string, kind: OpenKind, now: number): void {
    this.pending.set(openId, { itemId, kind, openedAt: now });
  }

  /**
   * Record a close. If the open persisted at least its minimum duration, the
   * item's open boolean is set (and stays set for the session — dedup). A close
   * below the threshold, or for an unknown openId, counts as nothing.
   */
  close(openId: string, now: number): void {
    const pending = this.pending.get(openId);
    if (!pending) return;
    this.pending.delete(openId);
    const minMs = pending.kind === 'source' ? this.config.sourceMinMs : this.config.contextMinMs;
    if (now - pending.openedAt < minMs) return;
    const item = this.opened.get(pending.itemId) ?? { source: false, context: false };
    item[pending.kind] = true;
    this.opened.set(pending.itemId, item);
  }

  wasSourceOpened(itemId: string): boolean {
    return this.opened.get(itemId)?.source ?? false;
  }

  wasContextOpened(itemId: string): boolean {
    return this.opened.get(itemId)?.context ?? false;
  }

  /** New session ⇒ opens are counted afresh. Drops any in-flight opens too. */
  resetSession(): void {
    this.opened.clear();
    this.pending.clear();
  }
}
