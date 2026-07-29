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
import type { ActorBehaviorWindow } from '@licio/invariants';
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

/**
 * The §22.1 pseudonym placeholder written into de-linked payloads: a fixed,
 * schema-valid, obviously synthetic UUID that replaces a payload `user_id`
 * when a row is pseudonymized (minimum-privacy ingestion and owner
 * de-linking at account deletion).
 */
export const PSEUDONYMOUS_USER_ID = '00000000-0000-4000-8000-000000000000';

export interface EventStore {
  /**
   * Insert events; duplicates are skipped and reported. Idempotency is on
   * `event_id` ALONE (globally — never per retention tier): the durable
   * replay backstop must hold even if a topic's tier assignment changes
   * across deployments.
   */
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
  /** Delete a user's owned rows — optionally scoped to retention tiers
   *  (attention reset deletes attention tiers ONLY, WS-E.1.4/SPEC §19.3). */
  deleteByOwner(userId: string, tiers?: readonly RetentionTier[]): Promise<number>;
  /**
   * De-link a user's remaining owned rows (account deletion): the owner ref
   * clears and any payload `user_id` is rewritten to the pseudonym, so
   * non-attention history (contributions, privacy-request records) survives
   * tombstoned rather than attributable. Returns rows changed.
   */
  anonymizeOwner(userId: string): Promise<number>;
  /** Delete rows of a tier with `timestamp` older than the cutoff. Batched. */
  deleteTierOlderThan(tier: RetentionTier, cutoffIso: string, limit: number): Promise<number>;
  /** Delete rows whose purge_after deadline has passed. Batched. */
  deletePurgeDue(nowIso: string, limit: number): Promise<number>;
  /** Compliance audit: rows past their purge_after deadline (should be 0). */
  countPurgeDue(nowIso: string): Promise<number>;
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

  async deleteByOwner(userId: string, tiers?: readonly RetentionTier[]): Promise<number> {
    const tierSet = tiers ? new Set(tiers) : null;
    let removed = 0;
    for (const [id, row] of this.#rows) {
      if (row.ownerUserId !== userId) continue;
      if (tierSet && !tierSet.has(row.retentionTier)) continue;
      this.#rows.delete(id);
      removed += 1;
    }
    return removed;
  }

  async anonymizeOwner(userId: string): Promise<number> {
    let changed = 0;
    for (const row of this.#rows.values()) {
      if (row.ownerUserId !== userId) continue;
      row.ownerUserId = null;
      if ('user_id' in row.payload) {
        row.payload = { ...row.payload, user_id: PSEUDONYMOUS_USER_ID };
      }
      changed += 1;
    }
    return changed;
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

  async countPurgeDue(nowIso: string): Promise<number> {
    const now = Date.parse(nowIso);
    let count = 0;
    for (const row of this.#rows.values()) {
      if (row.purgeAfter !== null && Date.parse(row.purgeAfter) <= now) count += 1;
    }
    return count;
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
  /** Retained for pre-WS-T clients during the dual-accept window. */
  branch_depth_bucket?: string;
  reply_depth_bucket?: string;
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
  /** A user's rows created at/after `sinceIso` (bounded reads for the WS-I
   *  per-request seen-history and PHI session lookups — never a full scan
   *  of a heavy reader's history on the serving path). */
  listByUserSince(userId: string, sinceIso: string): Promise<AttentionAggregateRecord[]>;
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

  async listByUserSince(userId: string, sinceIso: string): Promise<AttentionAggregateRecord[]> {
    return [...this.#rows.values()].filter(
      (row) => row.user_id_or_privacy_bucket === userId && row.created_at >= sinceIso,
    );
  }

  async insertMany(rows: readonly AttentionAggregateRecord[]): Promise<number> {
    let inserted = 0;
    for (const row of rows) {
      if (this.#rows.has(row.aggregate_id)) continue;
      const replyDepth = row.reply_depth_bucket ?? row.branch_depth_bucket ?? 'none';
      this.#rows.set(row.aggregate_id, {
        ...row,
        reply_depth_bucket: replyDepth,
        branch_depth_bucket: row.branch_depth_bucket ?? replyDepth,
      });
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
// Invariant outputs (§22.1 + shadow flag, WS-E.2.1e + the WS-H envelope).
// ---------------------------------------------------------------------------

/** Half-open computation window [start, end) as ISO instants (WS-H.1.1a). */
export interface InvariantTimeWindow {
  start: string;
  end: string;
}

export interface InvariantOutputRecord {
  invariantType: string;
  targetType: string;
  targetId: string;
  timeWindow: InvariantTimeWindow;
  version: string;
  /** Validated per invariant type before insert (WS-H.1.1d schemas). */
  scoreVector: Record<string, unknown>;
  explanationSummary: string | null;
  confidence: number;
  /** Fraction of required inputs available and fresh (WS-H.1.1c). */
  coverage: number;
  /** Registry-validated reason codes; [] = unqualified output. */
  reasonCodes: string[];
  fallbackUsed: boolean;
  /** Algorithm config snapshot for reproducibility (WS-H.1.1b); null = none. */
  versionMetadata: Record<string, unknown> | null;
  shadowMode: boolean;
  createdAt: string;
}

export interface InvariantOutputStore {
  /** Upsert on the natural key (type, targetType, targetId, window, version). */
  upsert(row: InvariantOutputRecord): Promise<void>;
  listForTarget(targetId: string): Promise<InvariantOutputRecord[]>;
  /** Latest output of a type for a target (by createdAt, then window start). */
  latest(invariantType: string, targetId: string): Promise<InvariantOutputRecord | null>;
  /**
   * The most recent SAME-SIZE window of `invariantType` for `targetId` that
   * starts strictly before `beforeStartIso` — the `rising`-mode velocity's
   * previous window.
   *
   * A dedicated query rather than a filter over `listForTarget`, which loads
   * every row the target has ever had — all types, all windows, all history —
   * into the heap.  That ran per CANDIDATE on the feed path, so a story with a
   * year of hourly windows cost thousands of rows to answer a question about
   * one of them.
   *
   * Ordering is `window start DESC, createdAt DESC, version DESC`: a total
   * order, and the same tie-break the caller applied, so the answer is
   * replay-stable independent of the store's physical row order.
   */
  previousWindow(input: {
    invariantType: string;
    targetId: string;
    beforeStartIso: string;
    spanMs: number;
    /** Rows to consider before giving up; each is re-checked against the §30.5
     *  serving gate in code, which no SQL predicate can express in full. */
    limit: number;
  }): Promise<InvariantOutputRecord[]>;
  /**
   * Paired outputs of two versions of one invariant over the same targets
   * (WS-H.1.1b A/B comparison), optionally bounded to a time window.
   */
  listForVersionComparison(
    invariantType: string,
    versionA: string,
    versionB: string,
    window?: InvariantTimeWindow,
  ): Promise<InvariantOutputRecord[]>;
  /** Rows of ONE invariant type created at/after `sinceIso`, newest first,
   *  capped at `limit` (the WS-I GWEI-gate input — a targeted read, never a
   *  full-table scan on the serving path). */
  listByTypeSince(
    invariantType: string,
    sinceIso: string,
    limit: number,
  ): Promise<InvariantOutputRecord[]>;
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
    return [
      row.invariantType,
      row.targetType,
      row.targetId,
      row.timeWindow.start,
      row.timeWindow.end,
      row.version,
    ].join('|');
  }

  async upsert(row: InvariantOutputRecord): Promise<void> {
    this.#rows.set(this.#key(row), { ...row });
  }

  async listForTarget(targetId: string): Promise<InvariantOutputRecord[]> {
    return [...this.#rows.values()].filter((r) => r.targetId === targetId);
  }

  async previousWindow(input: {
    invariantType: string;
    targetId: string;
    beforeStartIso: string;
    spanMs: number;
    limit: number;
  }): Promise<InvariantOutputRecord[]> {
    const before = Date.parse(input.beforeStartIso);
    return [...this.#rows.values()]
      .filter(
        (r) =>
          r.targetId === input.targetId &&
          r.invariantType === input.invariantType &&
          // The §30.5 boundary's row-level half, mirroring the Drizzle
          // adapter's `shadow_mode = false`: an in-memory store more permissive
          // than production lets a defect pass every unit test.
          r.shadowMode === false &&
          Date.parse(r.timeWindow.start) < before &&
          Date.parse(r.timeWindow.end) - Date.parse(r.timeWindow.start) === input.spanMs,
      )
      .sort(
        (a, b) =>
          Date.parse(b.timeWindow.start) - Date.parse(a.timeWindow.start) ||
          Date.parse(b.createdAt) - Date.parse(a.createdAt) ||
          // A TOTAL order — two revisions written in the same instant must
          // still have one answer, or serving and replay could disagree.
          b.version.localeCompare(a.version),
      )
      .slice(0, Math.max(0, input.limit));
  }

  async listByTypeSince(
    invariantType: string,
    sinceIso: string,
    limit: number,
  ): Promise<InvariantOutputRecord[]> {
    return [...this.#rows.values()]
      .filter((r) => r.invariantType === invariantType && r.createdAt >= sinceIso)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, Math.max(0, limit));
  }

  async latest(invariantType: string, targetId: string): Promise<InvariantOutputRecord | null> {
    const rows = [...this.#rows.values()]
      .filter((r) => r.invariantType === invariantType && r.targetId === targetId)
      .sort(
        (a, b) =>
          Date.parse(b.createdAt) - Date.parse(a.createdAt) ||
          b.timeWindow.start.localeCompare(a.timeWindow.start),
      );
    return rows[0] ?? null;
  }

  async listForVersionComparison(
    invariantType: string,
    versionA: string,
    versionB: string,
    window?: InvariantTimeWindow,
  ): Promise<InvariantOutputRecord[]> {
    return [...this.#rows.values()]
      .filter(
        (r) =>
          r.invariantType === invariantType &&
          (r.version === versionA || r.version === versionB) &&
          (!window || (r.timeWindow.start >= window.start && r.timeWindow.end <= window.end)),
      )
      .sort(
        (a, b) =>
          a.targetId.localeCompare(b.targetId) ||
          a.timeWindow.start.localeCompare(b.timeWindow.start) ||
          a.version.localeCompare(b.version),
      );
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
      const key = this.#naturalKey(entry);
      const existing = this.#rows.get(key);
      // Preserve the ORIGINAL entryId + recordedAt on an idempotent re-score of
      // the same (owner,item,window) — so the keyset cursor (recordedAt|entryId)
      // stays valid and re-scored rows do not jump to the top of the ledger.
      // Matches the Drizzle upsert (which omits both from its conflict update).
      this.#rows.set(key, {
        ...entry,
        antiSignals: [...entry.antiSignals],
        ...(existing ? { entryId: existing.entryId, recordedAt: existing.recordedAt } : {}),
      });
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
        // Match the AUTHORITATIVE Drizzle order (recordedAt DESC, entryId DESC):
        // the in-memory tie-break was entryId ASC, so the two adapters paginated
        // same-millisecond rows in opposite order.
        (a, b) =>
          Date.parse(b.recordedAt) - Date.parse(a.recordedAt) || b.entryId.localeCompare(a.entryId),
      );
    let start = 0;
    if (cursor) {
      const [cursorRecordedAt, cursorEntryId] = cursor.split('|');
      // Keyset (range) resolution matching the Drizzle store: the first row that
      // sorts strictly AFTER the cursor in the (recordedAt DESC, entryId DESC)
      // order (row-value `(recordedAt, entryId) < cursor`).  Resolving by range
      // (not an exact row match) degrades gracefully if the cursor's row was
      // purged — pagination resumes at the right place instead of resetting.
      const cursorMs = Date.parse(cursorRecordedAt ?? '');
      const found = sorted.findIndex(
        (r) =>
          Date.parse(r.recordedAt) < cursorMs ||
          (r.recordedAt === cursorRecordedAt && r.entryId < (cursorEntryId ?? '')),
      );
      start = found === -1 ? sorted.length : found;
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
  /** The SERVED PWAtt components pinned at freeze time (§5.3 freeze growth):
   *  the ranking feature store reads components, so the freeze must pin them or
   *  a frozen item keeps growing. Null/absent when not frozen / no prior level;
   *  the scoring + moderation paths set them explicitly on every freeze. */
  frozenActiveAttention?: number | null;
  frozenParticipation?: number | null;
  caseId: string | null;
  updatedBy: string;
  updatedAt: string;
}

export interface ItemSafetyStateStore {
  get(itemId: string): Promise<ItemSafetyRecord | null>;
  /** Batch read for the WS-I safety filter (one query per pool, not per
   *  item). Absent items simply have no entry in the returned map. */
  getMany(itemIds: readonly string[]): Promise<Map<string, ItemSafetyRecord>>;
  set(record: ItemSafetyRecord): Promise<void>;
  clear(): Promise<void>;
}

export class InMemoryItemSafetyStateStore implements ItemSafetyStateStore {
  readonly #rows = new Map<string, ItemSafetyRecord>();

  async get(itemId: string): Promise<ItemSafetyRecord | null> {
    return this.#rows.get(itemId) ?? null;
  }

  async getMany(itemIds: readonly string[]): Promise<Map<string, ItemSafetyRecord>> {
    const out = new Map<string, ItemSafetyRecord>();
    for (const itemId of itemIds) {
      const row = this.#rows.get(itemId);
      if (row !== undefined) out.set(itemId, { ...row });
    }
    return out;
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

// ---------------------------------------------------------------------------
// Actor behavior windows + authenticity assessments (bot-prevention layer 2).
// ---------------------------------------------------------------------------

/** One identifiable actor's behavior snapshot for one 1h window (the
 *  @licio/invariants ActorBehaviorWindow shape keyed by the actor).  The
 *  coarse privacy-bucket actor is NEVER recorded here. */
export interface ActorBehaviorWindowRecord extends ActorBehaviorWindow {
  actorRef: string;
}

/** The actor's current authenticity assessment (internal integrity state —
 *  never a public surface, never part of a DSAR export: the WS-J/WS-N
 *  anti-tipping-off posture for anti-abuse internals). */
export interface ActorAuthenticityRecord {
  actorRef: string;
  /** Effective multiplier (coherence × duplication, floored; (0, 1]). */
  score: number;
  /** Coherence composite before duplication ((0, 1]). */
  coherence: number;
  components: Record<string, number>;
  flags: string[];
  evidence: number;
  clusterId: string | null;
  clusterSize: number;
  computedAt: string;
}

export interface ActorBehaviorStore {
  /** Idempotent per-(actor, window) upsert — window re-scores converge. */
  upsertWindows(records: readonly ActorBehaviorWindowRecord[]): Promise<void>;
  /** Every stored window at or after `sinceIso`, for the batch assessment. */
  listWindowsSince(sinceIso: string): Promise<ActorBehaviorWindowRecord[]>;
  /** Prune windows older than the assessment lookback; returns rows removed. */
  deleteWindowsOlderThan(cutoffIso: string): Promise<number>;
  upsertAuthenticity(records: readonly ActorAuthenticityRecord[]): Promise<void>;
  getAuthenticity(actorRef: string): Promise<ActorAuthenticityRecord | null>;
  /** Batch read for the window scorer (one round trip per window rather than
   *  a point read per distinct actor). Absent actors are simply omitted. */
  getAuthenticityMany(actorRefs: readonly string[]): Promise<Map<string, ActorAuthenticityRecord>>;
  /** Every current assessment (the BAI platform-invariant input). */
  listAuthenticity(): Promise<ActorAuthenticityRecord[]>;
  /** Prune assessments not refreshed since `cutoffIso` (their actor went
   *  dormant): keeps the population stats + table bounded to recently-active
   *  actors, matching the window retention. Returns rows removed. */
  deleteAuthenticityOlderThan(cutoffIso: string): Promise<number>;
  /** Deletion-path purge: behavior state never outlives the account. */
  purgeActor(actorRef: string): Promise<number>;
  clear(): Promise<void>;
}

export class InMemoryActorBehaviorStore implements ActorBehaviorStore {
  readonly #windows = new Map<string, ActorBehaviorWindowRecord>();
  readonly #scores = new Map<string, ActorAuthenticityRecord>();

  #key(actorRef: string, windowStart: string): string {
    return `${actorRef}|${windowStart}`;
  }

  async upsertWindows(records: readonly ActorBehaviorWindowRecord[]): Promise<void> {
    for (const record of records) {
      this.#windows.set(this.#key(record.actorRef, record.windowStart), structuredClone(record));
    }
  }

  async listWindowsSince(sinceIso: string): Promise<ActorBehaviorWindowRecord[]> {
    const since = Date.parse(sinceIso);
    return [...this.#windows.values()]
      .filter((w) => Date.parse(w.windowStart) >= since)
      .sort(
        (a, b) =>
          a.actorRef.localeCompare(b.actorRef) || a.windowStart.localeCompare(b.windowStart),
      )
      .map((w) => structuredClone(w));
  }

  async deleteWindowsOlderThan(cutoffIso: string): Promise<number> {
    const cutoff = Date.parse(cutoffIso);
    let removed = 0;
    for (const [key, row] of this.#windows) {
      if (Date.parse(row.windowStart) < cutoff) {
        this.#windows.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  async upsertAuthenticity(records: readonly ActorAuthenticityRecord[]): Promise<void> {
    for (const record of records) {
      this.#scores.set(record.actorRef, structuredClone(record));
    }
  }

  async getAuthenticity(actorRef: string): Promise<ActorAuthenticityRecord | null> {
    const record = this.#scores.get(actorRef);
    return record ? structuredClone(record) : null;
  }

  async getAuthenticityMany(
    actorRefs: readonly string[],
  ): Promise<Map<string, ActorAuthenticityRecord>> {
    const out = new Map<string, ActorAuthenticityRecord>();
    for (const actorRef of actorRefs) {
      const record = this.#scores.get(actorRef);
      if (record) out.set(actorRef, structuredClone(record));
    }
    return out;
  }

  async listAuthenticity(): Promise<ActorAuthenticityRecord[]> {
    return [...this.#scores.values()]
      .sort((a, b) => a.actorRef.localeCompare(b.actorRef))
      .map((r) => structuredClone(r));
  }

  async deleteAuthenticityOlderThan(cutoffIso: string): Promise<number> {
    const cutoff = Date.parse(cutoffIso);
    let removed = 0;
    for (const [key, row] of this.#scores) {
      if (Date.parse(row.computedAt) < cutoff) {
        this.#scores.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  async purgeActor(actorRef: string): Promise<number> {
    let removed = 0;
    for (const [key, row] of this.#windows) {
      if (row.actorRef === actorRef) {
        this.#windows.delete(key);
        removed += 1;
      }
    }
    if (this.#scores.delete(actorRef)) removed += 1;
    return removed;
  }

  async clear(): Promise<void> {
    this.#windows.clear();
    this.#scores.clear();
  }
}
