// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Event-pipeline store interfaces + in-memory adapters (WS-E.3.1). The same
// interfaces are satisfied by the production Drizzle adapters
// (drizzle-event-stores.ts), mirroring the WS-D identity-store pattern: tests
// and dev run fully in memory; production swaps Postgres in at boot.
//
// Durability invariants enforced here (and by the DB constraints in
// packages/db schema/events.ts):
//   • events are idempotent on event_id — a duplicate insert is reported, not
//     applied (the durable replay backstop, WS-E.1.3b);
//   • classification and retention tier are required on every row (storage-
//     layer defense in depth, WS-E.3.1);
//   • retention operations are batched and idempotent (WS-E.1.4).
import type { PrivacyClassification, RetentionTier } from '@licio/shared';

/** A stored event row (ISO timestamps; mirrors packages/db `events`). */
export interface StoredEvent {
  eventId: string;
  eventType: string;
  topic: string;
  timestamp: string;
  privacyClassification: PrivacyClassification;
  retentionTier: RetentionTier;
  payload: Record<string, unknown>;
  ownerUserId: string | null;
  createdAt: string;
  purgeAfter: string | null;
  reviewFlaggedAt: string | null;
}

export type NewStoredEvent = Omit<StoredEvent, 'createdAt' | 'reviewFlaggedAt'> & {
  createdAt?: string;
};

export interface EventStore {
  /** Insert events; duplicates (by event_id) are skipped and reported. */
  insertMany(
    events: readonly NewStoredEvent[],
  ): Promise<{ inserted: number; duplicateIds: string[] }>;
  /** One event by id, or null (dead-letter re-drive, diagnostics). */
  getById(eventId: string): Promise<StoredEvent | null>;
  /** Events for topics within [fromIso, toIsoExclusive), oldest first. */
  listByTopicsBetween(
    topics: readonly string[],
    fromIso: string,
    toIsoExclusive: string,
  ): Promise<StoredEvent[]>;
  /** All events owned by a user (deletion/export, SPEC §19.3). */
  listByOwner(userId: string): Promise<StoredEvent[]>;
  deleteByOwner(userId: string): Promise<number>;
  /** Delete rows of a tier with `timestamp` older than the cutoff. Batched. */
  deleteTierOlderThan(tier: RetentionTier, cutoffIso: string, limit: number): Promise<number>;
  /** Delete rows whose purge_after deadline has passed. Batched. */
  deletePurgeDue(nowIso: string, limit: number): Promise<number>;
  /** Shorten (never extend) purge_after for a user's rows of a tier. */
  tightenOwnerPurge(userId: string, tier: RetentionTier, purgeAfterIso: string): Promise<number>;
  /** Flag (idempotently) moderation rows older than the cutoff for review. */
  flagModerationForReview(cutoffIso: string, limit: number): Promise<number>;
  /** Compliance audit: rows of a tier older than the cutoff (should be 0). */
  countTierOlderThan(tier: RetentionTier, cutoffIso: string): Promise<number>;
  /** Distinct owners holding rows of a tier (preference-aware sweeps). */
  listOwnersWithTier(tier: RetentionTier): Promise<string[]>;
  /**
   * The newest server-receipt instant (created_at) among events of `topics`
   * whose event time falls in [fromIso, toIsoExclusive) — the freshness marker
   * the scheduler compares against a window's computedAt so late-arriving
   * offline-sync events trigger a recompute and unchanged windows are skipped.
   */
  latestCreatedAtBetween(
    topics: readonly string[],
    fromIso: string,
    toIsoExclusive: string,
  ): Promise<string | null>;
  clear(): Promise<void>;
}

export class InMemoryEventStore implements EventStore {
  readonly #rows = new Map<string, StoredEvent>();

  async insertMany(
    events: readonly NewStoredEvent[],
  ): Promise<{ inserted: number; duplicateIds: string[] }> {
    const duplicateIds: string[] = [];
    let inserted = 0;
    for (const event of events) {
      if (this.#rows.has(event.eventId)) {
        duplicateIds.push(event.eventId);
        continue;
      }
      this.#rows.set(event.eventId, {
        ...event,
        createdAt: event.createdAt ?? new Date().toISOString(),
        reviewFlaggedAt: null,
      });
      inserted += 1;
    }
    return { inserted, duplicateIds };
  }

  async getById(eventId: string): Promise<StoredEvent | null> {
    return this.#rows.get(eventId) ?? null;
  }

  async listByTopicsBetween(
    topics: readonly string[],
    fromIso: string,
    toIsoExclusive: string,
  ): Promise<StoredEvent[]> {
    const topicSet = new Set(topics);
    const from = Date.parse(fromIso);
    const to = Date.parse(toIsoExclusive);
    return [...this.#rows.values()]
      .filter((row) => {
        const at = Date.parse(row.timestamp);
        return topicSet.has(row.topic) && at >= from && at < to;
      })
      .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  }

  async listByOwner(userId: string): Promise<StoredEvent[]> {
    return [...this.#rows.values()].filter((row) => row.ownerUserId === userId);
  }

  async deleteByOwner(userId: string): Promise<number> {
    let removed = 0;
    for (const [id, row] of this.#rows) {
      if (row.ownerUserId === userId) {
        this.#rows.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  async deleteTierOlderThan(
    tier: RetentionTier,
    cutoffIso: string,
    limit: number,
  ): Promise<number> {
    const cutoff = Date.parse(cutoffIso);
    let removed = 0;
    for (const [id, row] of this.#rows) {
      if (removed >= limit) break;
      if (row.retentionTier === tier && Date.parse(row.timestamp) < cutoff) {
        this.#rows.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  async deletePurgeDue(nowIso: string, limit: number): Promise<number> {
    const now = Date.parse(nowIso);
    let removed = 0;
    for (const [id, row] of this.#rows) {
      if (removed >= limit) break;
      if (row.purgeAfter !== null && Date.parse(row.purgeAfter) <= now) {
        this.#rows.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  async tightenOwnerPurge(
    userId: string,
    tier: RetentionTier,
    purgeAfterIso: string,
  ): Promise<number> {
    const next = Date.parse(purgeAfterIso);
    let updated = 0;
    for (const row of this.#rows.values()) {
      if (row.ownerUserId !== userId || row.retentionTier !== tier) continue;
      const current =
        row.purgeAfter === null ? Number.POSITIVE_INFINITY : Date.parse(row.purgeAfter);
      if (next < current) {
        row.purgeAfter = purgeAfterIso;
        updated += 1;
      }
    }
    return updated;
  }

  async flagModerationForReview(cutoffIso: string, limit: number): Promise<number> {
    const cutoff = Date.parse(cutoffIso);
    let flagged = 0;
    for (const row of this.#rows.values()) {
      if (flagged >= limit) break;
      if (
        row.retentionTier === 'moderation_legal' &&
        row.reviewFlaggedAt === null &&
        Date.parse(row.timestamp) < cutoff
      ) {
        row.reviewFlaggedAt = new Date().toISOString();
        flagged += 1;
      }
    }
    return flagged;
  }

  async countTierOlderThan(tier: RetentionTier, cutoffIso: string): Promise<number> {
    const cutoff = Date.parse(cutoffIso);
    let count = 0;
    for (const row of this.#rows.values()) {
      if (row.retentionTier === tier && Date.parse(row.timestamp) < cutoff) count += 1;
    }
    return count;
  }

  async listOwnersWithTier(tier: RetentionTier): Promise<string[]> {
    const owners = new Set<string>();
    for (const row of this.#rows.values()) {
      if (row.retentionTier === tier && row.ownerUserId !== null) owners.add(row.ownerUserId);
    }
    return [...owners];
  }

  async latestCreatedAtBetween(
    topics: readonly string[],
    fromIso: string,
    toIsoExclusive: string,
  ): Promise<string | null> {
    const topicSet = new Set(topics);
    const from = Date.parse(fromIso);
    const to = Date.parse(toIsoExclusive);
    let latest: string | null = null;
    for (const row of this.#rows.values()) {
      const at = Date.parse(row.timestamp);
      if (!topicSet.has(row.topic) || at < from || at >= to) continue;
      if (latest === null || Date.parse(row.createdAt) > Date.parse(latest)) {
        latest = row.createdAt;
      }
    }
    return latest;
  }

  async clear(): Promise<void> {
    this.#rows.clear();
  }

  /** Test helper: count of stored rows. */
  get size(): number {
    return this.#rows.size;
  }
}

// ---------------------------------------------------------------------------
// AttentionAggregate store (§22.1 rows).
// ---------------------------------------------------------------------------

/** Mirrors the §22.1 entity exactly (snake_case fields preserved on the wire). */
export interface AttentionAggregateRecord {
  aggregate_id: string;
  user_id_or_privacy_bucket: string;
  story_id: string;
  session_bucket: string;
  active_dwell_bucket: string;
  source_opened: boolean;
  context_opened: boolean;
  branch_depth_bucket: string;
  return_visit_count_bucket: string;
  privacy_level: string;
  created_at: string;
}

/** The coarse pseudonym used at minimum privacy (mirrors the client constant). */
export const PRIVACY_BUCKET = 'privacy-bucket';

export interface AttentionAggregateStore {
  /** Insert rows; duplicate aggregate_ids are skipped (idempotent). */
  insertMany(rows: readonly AttentionAggregateRecord[]): Promise<number>;
  listByUser(userId: string): Promise<AttentionAggregateRecord[]>;
  deleteByUser(userId: string): Promise<number>;
  /** Distinct identifiable owners (excludes the privacy bucket). */
  listIdentifiableOwners(): Promise<string[]>;
  /** Pseudonymize an owner's rows older than the cutoff (anonymization). */
  anonymizeOwnedOlderThan(owner: string, cutoffIso: string): Promise<number>;
  /** Delete an owner's rows older than the cutoff (preference `none`). */
  deleteOwnedOlderThan(owner: string, cutoffIso: string): Promise<number>;
  /** Delete already-anonymized rows older than the hard cap. */
  deleteAnonymizedOlderThan(cutoffIso: string): Promise<number>;
  /** Compliance audit: identifiable rows older than the cutoff (expect 0). */
  countIdentifiableOlderThan(cutoffIso: string): Promise<number>;
  clear(): Promise<void>;
}

export class InMemoryAttentionAggregateStore implements AttentionAggregateStore {
  readonly #rows = new Map<string, AttentionAggregateRecord>();

  async insertMany(rows: readonly AttentionAggregateRecord[]): Promise<number> {
    let inserted = 0;
    for (const row of rows) {
      if (this.#rows.has(row.aggregate_id)) continue;
      this.#rows.set(row.aggregate_id, { ...row });
      inserted += 1;
    }
    return inserted;
  }

  async listByUser(userId: string): Promise<AttentionAggregateRecord[]> {
    return [...this.#rows.values()].filter((r) => r.user_id_or_privacy_bucket === userId);
  }

  async deleteByUser(userId: string): Promise<number> {
    let removed = 0;
    for (const [id, row] of this.#rows) {
      if (row.user_id_or_privacy_bucket === userId) {
        this.#rows.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  async listIdentifiableOwners(): Promise<string[]> {
    const owners = new Set<string>();
    for (const row of this.#rows.values()) {
      if (row.user_id_or_privacy_bucket !== PRIVACY_BUCKET) {
        owners.add(row.user_id_or_privacy_bucket);
      }
    }
    return [...owners];
  }

  async anonymizeOwnedOlderThan(owner: string, cutoffIso: string): Promise<number> {
    const cutoff = Date.parse(cutoffIso);
    let changed = 0;
    for (const row of this.#rows.values()) {
      if (row.user_id_or_privacy_bucket === owner && Date.parse(row.created_at) < cutoff) {
        row.user_id_or_privacy_bucket = PRIVACY_BUCKET;
        row.privacy_level = 'minimum';
        changed += 1;
      }
    }
    return changed;
  }

  async deleteOwnedOlderThan(owner: string, cutoffIso: string): Promise<number> {
    const cutoff = Date.parse(cutoffIso);
    let removed = 0;
    for (const [id, row] of this.#rows) {
      if (row.user_id_or_privacy_bucket === owner && Date.parse(row.created_at) < cutoff) {
        this.#rows.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  async deleteAnonymizedOlderThan(cutoffIso: string): Promise<number> {
    const cutoff = Date.parse(cutoffIso);
    let removed = 0;
    for (const [id, row] of this.#rows) {
      if (row.user_id_or_privacy_bucket === PRIVACY_BUCKET && Date.parse(row.created_at) < cutoff) {
        this.#rows.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  async countIdentifiableOlderThan(cutoffIso: string): Promise<number> {
    const cutoff = Date.parse(cutoffIso);
    let count = 0;
    for (const row of this.#rows.values()) {
      if (row.user_id_or_privacy_bucket !== PRIVACY_BUCKET && Date.parse(row.created_at) < cutoff) {
        count += 1;
      }
    }
    return count;
  }

  async clear(): Promise<void> {
    this.#rows.clear();
  }
}

// ---------------------------------------------------------------------------
// Aggregation windows (WS-E.2.1a).
// ---------------------------------------------------------------------------

export type AggregationWindowSize = '1h' | '6h' | '24h' | '7d';

export interface AggregationWindowRecord {
  itemId: string;
  windowStart: string;
  windowSize: AggregationWindowSize;
  uniqueActiveUsers: number;
  sourceOpens: number;
  contextOpens: number;
  returnVisits: number;
  contributionCounts: Record<string, number>;
  antiSignalCounts: Record<string, number>;
  eventCount: number;
  computedAt: string;
}

export interface AggregationWindowStore {
  upsert(row: AggregationWindowRecord): Promise<void>;
  get(
    itemId: string,
    windowStart: string,
    windowSize: AggregationWindowSize,
  ): Promise<AggregationWindowRecord | null>;
  /** Trailing windows for an item strictly before `beforeIso`, newest first. */
  listForItemBefore(
    itemId: string,
    windowSize: AggregationWindowSize,
    beforeIso: string,
    limit: number,
  ): Promise<AggregationWindowRecord[]>;
  deleteOlderThan(cutoffIso: string): Promise<number>;
  /**
   * The computedAt of the window's stored rows (all rows of one window run
   * share it), or null when the window has never been computed — compared
   * against the event store's freshness marker by the scheduler.
   */
  latestComputedAt(windowStart: string, windowSize: AggregationWindowSize): Promise<string | null>;
  clear(): Promise<void>;
}

export class InMemoryAggregationWindowStore implements AggregationWindowStore {
  readonly #rows = new Map<string, AggregationWindowRecord>();

  #key(itemId: string, windowStart: string, windowSize: AggregationWindowSize): string {
    return `${itemId}|${windowStart}|${windowSize}`;
  }

  async upsert(row: AggregationWindowRecord): Promise<void> {
    this.#rows.set(this.#key(row.itemId, row.windowStart, row.windowSize), { ...row });
  }

  async get(
    itemId: string,
    windowStart: string,
    windowSize: AggregationWindowSize,
  ): Promise<AggregationWindowRecord | null> {
    return this.#rows.get(this.#key(itemId, windowStart, windowSize)) ?? null;
  }

  async listForItemBefore(
    itemId: string,
    windowSize: AggregationWindowSize,
    beforeIso: string,
    limit: number,
  ): Promise<AggregationWindowRecord[]> {
    const before = Date.parse(beforeIso);
    return [...this.#rows.values()]
      .filter(
        (r) =>
          r.itemId === itemId && r.windowSize === windowSize && Date.parse(r.windowStart) < before,
      )
      .sort((a, b) => Date.parse(b.windowStart) - Date.parse(a.windowStart))
      .slice(0, limit);
  }

  async deleteOlderThan(cutoffIso: string): Promise<number> {
    const cutoff = Date.parse(cutoffIso);
    let removed = 0;
    for (const [key, row] of this.#rows) {
      if (Date.parse(row.windowStart) < cutoff) {
        this.#rows.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  async latestComputedAt(
    windowStart: string,
    windowSize: AggregationWindowSize,
  ): Promise<string | null> {
    const start = Date.parse(windowStart);
    let latest: string | null = null;
    for (const row of this.#rows.values()) {
      if (Date.parse(row.windowStart) !== start || row.windowSize !== windowSize) continue;
      if (latest === null || Date.parse(row.computedAt) > Date.parse(latest)) {
        latest = row.computedAt;
      }
    }
    return latest;
  }

  async clear(): Promise<void> {
    this.#rows.clear();
  }
}

// ---------------------------------------------------------------------------
// Invariant outputs (§22.1 + shadow flag, WS-E.2.1e).
// ---------------------------------------------------------------------------

export interface InvariantOutputRecord {
  invariantType: string;
  targetType: string;
  targetId: string;
  timeWindow: string;
  version: string;
  scoreVector: Record<string, number>;
  explanationSummary: string | null;
  confidence: number;
  shadowMode: boolean;
  createdAt: string;
}

export interface InvariantOutputStore {
  /** Upsert on the natural key (type, targetType, targetId, window, version). */
  upsert(row: InvariantOutputRecord): Promise<void>;
  listForTarget(targetId: string): Promise<InvariantOutputRecord[]>;
  /** Latest output of a type for a target (by createdAt, then window label). */
  latest(invariantType: string, targetId: string): Promise<InvariantOutputRecord | null>;
  listAll(): Promise<InvariantOutputRecord[]>;
  deleteOlderThan(cutoffIso: string): Promise<number>;
  countOlderThan(cutoffIso: string): Promise<number>;
  clear(): Promise<void>;
}

export class InMemoryInvariantOutputStore implements InvariantOutputStore {
  readonly #rows = new Map<string, InvariantOutputRecord>();

  #key(
    row: Pick<
      InvariantOutputRecord,
      'invariantType' | 'targetType' | 'targetId' | 'timeWindow' | 'version'
    >,
  ): string {
    return [row.invariantType, row.targetType, row.targetId, row.timeWindow, row.version].join('|');
  }

  async upsert(row: InvariantOutputRecord): Promise<void> {
    this.#rows.set(this.#key(row), { ...row });
  }

  async listForTarget(targetId: string): Promise<InvariantOutputRecord[]> {
    return [...this.#rows.values()].filter((r) => r.targetId === targetId);
  }

  async latest(invariantType: string, targetId: string): Promise<InvariantOutputRecord | null> {
    const rows = [...this.#rows.values()]
      .filter((r) => r.invariantType === invariantType && r.targetId === targetId)
      .sort(
        (a, b) =>
          Date.parse(b.createdAt) - Date.parse(a.createdAt) ||
          b.timeWindow.localeCompare(a.timeWindow),
      );
    return rows[0] ?? null;
  }

  async listAll(): Promise<InvariantOutputRecord[]> {
    return [...this.#rows.values()];
  }

  async deleteOlderThan(cutoffIso: string): Promise<number> {
    const cutoff = Date.parse(cutoffIso);
    let removed = 0;
    for (const [key, row] of this.#rows) {
      if (Date.parse(row.createdAt) < cutoff) {
        this.#rows.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  async countOlderThan(cutoffIso: string): Promise<number> {
    const cutoff = Date.parse(cutoffIso);
    return [...this.#rows.values()].filter((r) => Date.parse(r.createdAt) < cutoff).length;
  }

  async clear(): Promise<void> {
    this.#rows.clear();
  }
}

// ---------------------------------------------------------------------------
// Signal Ledger (WS-E.2.1d) — strictly owner-scoped.
// ---------------------------------------------------------------------------

export interface SignalLedgerRecord {
  entryId: string;
  ownerUserId: string;
  itemId: string;
  storyTitle: string;
  windowStart: string;
  windowSize: AggregationWindowSize;
  signals: Record<string, unknown>;
  antiSignals: string[];
  pwattScore: number;
  summary: string;
  recordedAt: string;
  purgeAfter: string;
}

export interface SignalLedgerStore {
  /** Upsert on (owner, item, windowStart, windowSize) — idempotent re-runs. */
  upsertMany(entries: readonly SignalLedgerRecord[]): Promise<void>;
  /** Owner-only listing, newest first, with keyset pagination. */
  listForUser(
    userId: string,
    limit: number,
    cursor?: string,
  ): Promise<{ entries: SignalLedgerRecord[]; nextCursor: string | null }>;
  deleteByUser(userId: string): Promise<number>;
  deletePurgeDue(nowIso: string): Promise<number>;
  /** Shorten (never extend) purge deadlines for an owner. */
  tightenOwnerPurge(userId: string, purgeAfterIso: string): Promise<number>;
  countOverRetained(nowIso: string): Promise<number>;
  clear(): Promise<void>;
}

export class InMemorySignalLedgerStore implements SignalLedgerStore {
  readonly #rows = new Map<string, SignalLedgerRecord>();

  #naturalKey(
    row: Pick<SignalLedgerRecord, 'ownerUserId' | 'itemId' | 'windowStart' | 'windowSize'>,
  ): string {
    return [row.ownerUserId, row.itemId, row.windowStart, row.windowSize].join('|');
  }

  async upsertMany(entries: readonly SignalLedgerRecord[]): Promise<void> {
    for (const entry of entries) {
      this.#rows.set(this.#naturalKey(entry), { ...entry, antiSignals: [...entry.antiSignals] });
    }
  }

  async listForUser(
    userId: string,
    limit: number,
    cursor?: string,
  ): Promise<{ entries: SignalLedgerRecord[]; nextCursor: string | null }> {
    const sorted = [...this.#rows.values()]
      .filter((r) => r.ownerUserId === userId)
      .sort(
        (a, b) =>
          Date.parse(b.recordedAt) - Date.parse(a.recordedAt) || a.entryId.localeCompare(b.entryId),
      );
    let start = 0;
    if (cursor) {
      const [cursorRecordedAt, cursorEntryId] = cursor.split('|');
      start = sorted.findIndex(
        (r) => r.recordedAt === cursorRecordedAt && r.entryId === cursorEntryId,
      );
      start = start === -1 ? 0 : start + 1;
    }
    const page = sorted.slice(start, start + limit);
    const last = page[page.length - 1];
    const hasMore = start + limit < sorted.length;
    return {
      entries: page,
      nextCursor: hasMore && last ? `${last.recordedAt}|${last.entryId}` : null,
    };
  }

  async deleteByUser(userId: string): Promise<number> {
    let removed = 0;
    for (const [key, row] of this.#rows) {
      if (row.ownerUserId === userId) {
        this.#rows.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  async deletePurgeDue(nowIso: string): Promise<number> {
    const now = Date.parse(nowIso);
    let removed = 0;
    for (const [key, row] of this.#rows) {
      if (Date.parse(row.purgeAfter) <= now) {
        this.#rows.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  async tightenOwnerPurge(userId: string, purgeAfterIso: string): Promise<number> {
    const next = Date.parse(purgeAfterIso);
    let updated = 0;
    for (const row of this.#rows.values()) {
      if (row.ownerUserId === userId && next < Date.parse(row.purgeAfter)) {
        row.purgeAfter = purgeAfterIso;
        updated += 1;
      }
    }
    return updated;
  }

  async countOverRetained(nowIso: string): Promise<number> {
    const now = Date.parse(nowIso);
    return [...this.#rows.values()].filter((r) => Date.parse(r.purgeAfter) <= now).length;
  }

  async clear(): Promise<void> {
    this.#rows.clear();
  }
}

// ---------------------------------------------------------------------------
// Item safety states (WS-E.2.3e).
// ---------------------------------------------------------------------------

export interface ItemSafetyRecord {
  itemId: string;
  safetyState: 'normal' | 'frozen' | 'removed';
  frozenScore: number | null;
  caseId: string | null;
  updatedBy: string;
  updatedAt: string;
}

export interface ItemSafetyStateStore {
  get(itemId: string): Promise<ItemSafetyRecord | null>;
  set(record: ItemSafetyRecord): Promise<void>;
  clear(): Promise<void>;
}

export class InMemoryItemSafetyStateStore implements ItemSafetyStateStore {
  readonly #rows = new Map<string, ItemSafetyRecord>();

  async get(itemId: string): Promise<ItemSafetyRecord | null> {
    return this.#rows.get(itemId) ?? null;
  }

  async set(record: ItemSafetyRecord): Promise<void> {
    this.#rows.set(record.itemId, { ...record });
  }

  async clear(): Promise<void> {
    this.#rows.clear();
  }
}

// ---------------------------------------------------------------------------
// PWAtt config (WS-E.2.3a-d: tunable without redeploy).
// ---------------------------------------------------------------------------

export interface PwattConfigStore {
  get(key: string): Promise<Record<string, unknown> | null>;
  set(key: string, value: Record<string, unknown>): Promise<void>;
  clear(): Promise<void>;
}

export class InMemoryPwattConfigStore implements PwattConfigStore {
  readonly #rows = new Map<string, Record<string, unknown>>();

  async get(key: string): Promise<Record<string, unknown> | null> {
    return this.#rows.get(key) ?? null;
  }

  async set(key: string, value: Record<string, unknown>): Promise<void> {
    this.#rows.set(key, { ...value });
  }

  async clear(): Promise<void> {
    this.#rows.clear();
  }
}

// ---------------------------------------------------------------------------
// Dead letters + consumer checkpoints (WS-E.1.5).
// ---------------------------------------------------------------------------

export interface DeadLetterRecord {
  consumerName: string;
  eventId: string;
  topic: string;
  error: string;
  attempts: number;
  failedAt: string;
}

export interface DeadLetterStore {
  /**
   * Record a dead letter. AT MOST ONE letter exists per (consumer, event):
   * a repeated failure updates the letter and ACCUMULATES `attempts` instead
   * of duplicating the row.
   */
  append(record: DeadLetterRecord): Promise<void>;
  list(consumerName?: string): Promise<DeadLetterRecord[]>;
  /** Remove one dead letter (after a successful re-drive). */
  delete(consumerName: string, eventId: string): Promise<void>;
  clear(): Promise<void>;
}

export class InMemoryDeadLetterStore implements DeadLetterStore {
  readonly #rows: DeadLetterRecord[] = [];

  async append(record: DeadLetterRecord): Promise<void> {
    const existing = this.#rows.find(
      (r) => r.consumerName === record.consumerName && r.eventId === record.eventId,
    );
    if (existing) {
      existing.error = record.error;
      existing.failedAt = record.failedAt;
      existing.attempts += record.attempts;
      return;
    }
    this.#rows.push({ ...record });
  }

  async list(consumerName?: string): Promise<DeadLetterRecord[]> {
    return consumerName
      ? this.#rows.filter((r) => r.consumerName === consumerName)
      : [...this.#rows];
  }

  async delete(consumerName: string, eventId: string): Promise<void> {
    const index = this.#rows.findIndex(
      (r) => r.consumerName === consumerName && r.eventId === eventId,
    );
    if (index !== -1) this.#rows.splice(index, 1);
  }

  async clear(): Promise<void> {
    this.#rows.length = 0;
  }
}

export interface ConsumerCheckpointStore {
  get(consumerName: string): Promise<string | null>;
  set(consumerName: string, lastEventTimestampIso: string): Promise<void>;
  clear(): Promise<void>;
}

export class InMemoryConsumerCheckpointStore implements ConsumerCheckpointStore {
  readonly #rows = new Map<string, string>();

  async get(consumerName: string): Promise<string | null> {
    return this.#rows.get(consumerName) ?? null;
  }

  async set(consumerName: string, lastEventTimestampIso: string): Promise<void> {
    this.#rows.set(consumerName, lastEventTimestampIso);
  }

  async clear(): Promise<void> {
    this.#rows.clear();
  }
}
