// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-I store interfaces + in-memory adapters (the house pattern: abstract
// interfaces unit-tested in memory; Drizzle adapters swap in at boot with
// identical semantics).
//
// FeatureStore (WS-I.2.1d): per-item feature vectors as APPEND-ONLY revision
// history — `upsert` writes revision N+1 and never mutates an existing row,
// which is what makes replay (WS-I.2.5b) exact: the decision log records the
// revision each item was scored at, and `getRevision` returns that snapshot
// byte-for-byte. Every write passes the WS-I.2.1b denylist + the strict
// schema; there is NO privileged write path around validation.
//
// DecisionLogStore (WS-I.2.5a/c): one record per served feed request, keyed
// by request id, queryable on the six audit dimensions, retention-swept at
// the §22.4 deadline.

import {
  DeniedFinancialFieldError,
  type FeatureVector,
  findDeniedFields,
  type RankingDecisionLog,
  rankingDecisionLogSchema,
  validateFeatureVector,
} from '@licio/ranking';

/** A failed feature write (schema or denylist). */
export class FeatureValidationError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`feature vector rejected: ${problems.join('; ')}`);
    this.name = 'FeatureValidationError';
    this.problems = problems;
  }
}

export interface FeatureStore {
  /**
   * Validate + append the vector as the item's next revision. The caller
   * passes `revision` = the revision it BUILT FROM (optimistic concurrency):
   * the write succeeds only when that is still the latest revision, and the
   * stored row gets revision + 1 (monotonic; stale writers lose, WS-I.2.1d).
   * Throws {@link DeniedFinancialFieldError} on a denied financial field and
   * {@link FeatureValidationError} on any other schema violation. Returns
   * null when the optimistic check fails (caller re-reads and retries).
   */
  upsert(vector: FeatureVector): Promise<FeatureVector | null>;
  /** Latest revision for an item (null = the store has not covered it). */
  getLatest(itemId: string): Promise<FeatureVector | null>;
  /** The exact stored snapshot at a revision (replay join, WS-I.2.5b). */
  getRevision(itemId: string, revision: number): Promise<FeatureVector | null>;
  /** The revision in force AT an instant (WS-I.2.1c audit query: "the
   *  invariant versions for any feature vector by item_id and timestamp"):
   *  the newest revision with updated_at ≤ `atIso`, or null. */
  getAt(itemId: string, atIso: string): Promise<FeatureVector | null>;
  /** Latest revisions for many items at once (the feature-join stage). */
  getLatestMany(itemIds: readonly string[]): Promise<Map<string, FeatureVector>>;
  /** Items whose latest revision is older than `beforeIso` (batch refresh). */
  listStaleItems(beforeIso: string, limit: number): Promise<string[]>;
  clear(): Promise<void>;
}

export class InMemoryFeatureStore implements FeatureStore {
  /** itemId → revisions ascending (append-only). */
  readonly #rows = new Map<string, FeatureVector[]>();

  async upsert(vector: FeatureVector): Promise<FeatureVector | null> {
    const denied = findDeniedFields(vector);
    if (denied.length > 0) throw new DeniedFinancialFieldError(denied);
    const validated = validateFeatureVector(vector);
    if (!validated.ok) throw new FeatureValidationError(validated.problems);
    const history = this.#rows.get(vector.item_id) ?? [];
    const latest = history[history.length - 1];
    const latestRevision = latest === undefined ? -1 : latest.revision;
    // Optimistic concurrency: the writer must have built from the CURRENT
    // latest revision; a stale writer returns null and re-reads.
    if (vector.revision !== latestRevision + 1) return null;
    const stored: FeatureVector = structuredClone(validated.vector);
    history.push(stored);
    this.#rows.set(vector.item_id, history);
    return structuredClone(stored);
  }

  async getLatest(itemId: string): Promise<FeatureVector | null> {
    const history = this.#rows.get(itemId);
    const latest = history?.[history.length - 1];
    return latest === undefined ? null : structuredClone(latest);
  }

  async getRevision(itemId: string, revision: number): Promise<FeatureVector | null> {
    const row = this.#rows.get(itemId)?.find((r) => r.revision === revision);
    return row === undefined ? null : structuredClone(row);
  }

  async getAt(itemId: string, atIso: string): Promise<FeatureVector | null> {
    const row = [...(this.#rows.get(itemId) ?? [])]
      .filter((r) => r.updated_at <= atIso)
      .sort((a, b) => b.revision - a.revision)[0];
    return row === undefined ? null : structuredClone(row);
  }

  async getLatestMany(itemIds: readonly string[]): Promise<Map<string, FeatureVector>> {
    const out = new Map<string, FeatureVector>();
    for (const itemId of itemIds) {
      const latest = await this.getLatest(itemId);
      if (latest !== null) out.set(itemId, latest);
    }
    return out;
  }

  async listStaleItems(beforeIso: string, limit: number): Promise<string[]> {
    const stale: Array<{ itemId: string; updatedAt: string }> = [];
    for (const [itemId, history] of this.#rows) {
      const latest = history[history.length - 1];
      if (latest !== undefined && latest.updated_at < beforeIso) {
        stale.push({ itemId, updatedAt: latest.updated_at });
      }
    }
    return stale
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.itemId.localeCompare(b.itemId))
      .slice(0, Math.max(0, limit))
      .map((s) => s.itemId);
  }

  async clear(): Promise<void> {
    this.#rows.clear();
  }
}

/** The six WS-I.2.5c audit-query dimensions (+ pagination). */
export interface DecisionLogQuery {
  fromIso?: string;
  toIso?: string;
  userPrivacyBucket?: string;
  itemId?: string;
  invariantName?: string;
  invariantVersion?: string;
  constraint?: string;
  experimentId?: string;
  /** Opaque keyset cursor (the previous page's last request id). */
  afterRequestId?: string;
  limit: number;
}

export interface DecisionLogStore {
  /** Insert exactly one record per request (request_id unique). */
  insert(log: RankingDecisionLog): Promise<void>;
  getByRequestId(requestId: string): Promise<RankingDecisionLog | null>;
  /** Query on the audit dimensions, `(timestamp, request_id)` DESCENDING. */
  query(
    query: DecisionLogQuery,
  ): Promise<{ logs: RankingDecisionLog[]; nextCursor: string | null }>;
  /** Delete rows past their retention deadline; returns the count removed. */
  sweepExpired(nowIso: string): Promise<number>;
  count(): Promise<number>;
  clear(): Promise<void>;
}

export class InMemoryDecisionLogStore implements DecisionLogStore {
  readonly #rows = new Map<string, RankingDecisionLog>();

  async insert(log: RankingDecisionLog): Promise<void> {
    const validated = rankingDecisionLogSchema.parse(log);
    if (this.#rows.has(validated.request_id)) {
      throw new Error(`duplicate decision log for request ${validated.request_id}`);
    }
    this.#rows.set(validated.request_id, structuredClone(validated));
  }

  async getByRequestId(requestId: string): Promise<RankingDecisionLog | null> {
    const row = this.#rows.get(requestId);
    return row === undefined ? null : structuredClone(row);
  }

  async query(
    query: DecisionLogQuery,
  ): Promise<{ logs: RankingDecisionLog[]; nextCursor: string | null }> {
    const matches = (log: RankingDecisionLog): boolean => {
      if (query.fromIso !== undefined && log.timestamp < query.fromIso) return false;
      if (query.toIso !== undefined && log.timestamp >= query.toIso) return false;
      if (
        query.userPrivacyBucket !== undefined &&
        log.user_privacy_bucket !== query.userPrivacyBucket
      ) {
        return false;
      }
      if (
        query.itemId !== undefined &&
        !log.candidate_ids.includes(query.itemId) &&
        !log.selected_ids.includes(query.itemId)
      ) {
        return false;
      }
      if (query.invariantName !== undefined) {
        const entry = log.invariant_versions[query.invariantName];
        if (entry === undefined) return false;
        if (
          query.invariantVersion !== undefined &&
          entry.version_string !== query.invariantVersion
        ) {
          return false;
        }
      }
      if (
        query.constraint !== undefined &&
        !log.constraints_applied.some((c) => c.constraint === query.constraint)
      ) {
        return false;
      }
      if (query.experimentId !== undefined && !log.experiment_ids.includes(query.experimentId)) {
        return false;
      }
      return true;
    };
    const ordered = [...this.#rows.values()]
      .filter(matches)
      .sort(
        (a, b) =>
          b.timestamp.localeCompare(a.timestamp) || b.request_id.localeCompare(a.request_id),
      );
    let startIndex = 0;
    if (query.afterRequestId !== undefined) {
      const cursorIndex = ordered.findIndex((log) => log.request_id === query.afterRequestId);
      startIndex = cursorIndex === -1 ? ordered.length : cursorIndex + 1;
    }
    const limit = Math.max(1, Math.min(1000, query.limit));
    const page = ordered.slice(startIndex, startIndex + limit);
    const nextCursor =
      startIndex + limit < ordered.length && page.length > 0
        ? (page[page.length - 1]?.request_id ?? null)
        : null;
    return { logs: page.map((log) => structuredClone(log)), nextCursor };
  }

  async sweepExpired(nowIso: string): Promise<number> {
    let removed = 0;
    for (const [requestId, log] of this.#rows) {
      if (log.retain_until <= nowIso) {
        this.#rows.delete(requestId);
        removed += 1;
      }
    }
    return removed;
  }

  async count(): Promise<number> {
    return this.#rows.size;
  }

  async clear(): Promise<void> {
    this.#rows.clear();
  }
}
