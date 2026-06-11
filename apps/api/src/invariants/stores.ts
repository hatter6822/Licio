// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-H invariant-platform store interfaces + in-memory adapters, mirroring
// the WS-E/F/G pattern: tests and dev run in memory; production swaps the
// Drizzle adapters (drizzle-invariant-stores.ts) in at boot.
//
// Privacy note on session sequences (WS-H.6.1a): rows hold an OPAQUE
// session key, topic-cluster ids, and timestamps ONLY — no story ids, no
// content, no other user's identity — and every sequence expires with its
// session (TTL'd; swept on read and on append). The bounded cap is enforced
// at append time so session state can never grow without bound.

import type { TopicTransition } from '@licio/invariants';

// ---------------------------------------------------------------------------
// Promotions (WS-H.1.2e)
// ---------------------------------------------------------------------------

export interface PromotionRecordRow {
  invariantType: string;
  fromStatus: string;
  toStatus: string;
  evidence: Record<string, unknown>;
  owner: string;
  createdAt: string;
}

export interface PromotionStore {
  /** Append-only; resolution reads the latest record per invariant. */
  append(record: PromotionRecordRow): Promise<void>;
  listForInvariant(invariantType: string): Promise<PromotionRecordRow[]>;
  clear(): Promise<void>;
}

export class InMemoryPromotionStore implements PromotionStore {
  readonly #rows: PromotionRecordRow[] = [];

  async append(record: PromotionRecordRow): Promise<void> {
    this.#rows.push({ ...record });
  }

  async listForInvariant(invariantType: string): Promise<PromotionRecordRow[]> {
    return this.#rows
      .filter((r) => r.invariantType === invariantType)
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  }

  async clear(): Promise<void> {
    this.#rows.length = 0;
  }
}

// ---------------------------------------------------------------------------
// Calibrations (WS-H.3.1a null calibrations and similar reference data)
// ---------------------------------------------------------------------------

export interface CalibrationRow {
  calibrationKey: string;
  version: string;
  data: Record<string, unknown>;
  sampleCount: number;
  computedAt: string;
}

export interface CalibrationStore {
  upsert(row: CalibrationRow): Promise<void>;
  get(calibrationKey: string): Promise<CalibrationRow | null>;
  clear(): Promise<void>;
}

export class InMemoryCalibrationStore implements CalibrationStore {
  readonly #rows = new Map<string, CalibrationRow>();

  async upsert(row: CalibrationRow): Promise<void> {
    this.#rows.set(row.calibrationKey, { ...row });
  }

  async get(calibrationKey: string): Promise<CalibrationRow | null> {
    return this.#rows.get(calibrationKey) ?? null;
  }

  async clear(): Promise<void> {
    this.#rows.clear();
  }
}

// ---------------------------------------------------------------------------
// Run metadata (WS-H.1.2f/g)
// ---------------------------------------------------------------------------

export interface RunMetadataRow {
  invariantType: string;
  tier: 'realtime' | 'near_realtime' | 'batch';
  targetCount: number;
  durationMs: number;
  success: boolean;
  failureReason: string | null;
  startedAt: string;
}

export interface RunMetadataStore {
  append(row: RunMetadataRow): Promise<void>;
  /** Most recent runs for an invariant, newest first. */
  listRecent(invariantType: string, limit: number): Promise<RunMetadataRow[]>;
  clear(): Promise<void>;
}

export class InMemoryRunMetadataStore implements RunMetadataStore {
  readonly #rows: RunMetadataRow[] = [];

  async append(row: RunMetadataRow): Promise<void> {
    this.#rows.push({ ...row });
    if (this.#rows.length > 10_000) this.#rows.splice(0, this.#rows.length - 10_000);
  }

  async listRecent(invariantType: string, limit: number): Promise<RunMetadataRow[]> {
    return this.#rows
      .filter((r) => r.invariantType === invariantType)
      .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
      .slice(0, limit);
  }

  async clear(): Promise<void> {
    this.#rows.length = 0;
  }
}

// ---------------------------------------------------------------------------
// MFCI cases (WS-H.3.4b)
// ---------------------------------------------------------------------------

export type MfciCaseStatus = 'open' | 'confirmed' | 'cleared' | 'escalated';

export interface MfciCaseRowRecord {
  caseId: string;
  targetType: string;
  targetId: string;
  riskState: string;
  statistic: string;
  mfciScore: number;
  pHat: number;
  sampleCount: number;
  fixedMarginsRef: string;
  summary: string;
  appealSummary: string;
  status: MfciCaseStatus;
  openedAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
}

export interface MfciCaseStore {
  insert(row: MfciCaseRowRecord): Promise<void>;
  getById(caseId: string): Promise<MfciCaseRowRecord | null>;
  /** Open cases ordered by severity then recency (the analyst queue). */
  listOpen(limit: number): Promise<MfciCaseRowRecord[]>;
  /** Latest case (any status) for a target, newest first. */
  latestForTarget(targetId: string): Promise<MfciCaseRowRecord | null>;
  resolve(
    caseId: string,
    status: Exclude<MfciCaseStatus, 'open'>,
    resolvedBy: string,
    resolvedAt: string,
  ): Promise<MfciCaseRowRecord | null>;
  clear(): Promise<void>;
}

const RISK_SEVERITY: Record<string, number> = { severe: 3, high: 2, elevated: 1, normal: 0 };

export class InMemoryMfciCaseStore implements MfciCaseStore {
  readonly #rows = new Map<string, MfciCaseRowRecord>();

  async insert(row: MfciCaseRowRecord): Promise<void> {
    this.#rows.set(row.caseId, { ...row });
  }

  async getById(caseId: string): Promise<MfciCaseRowRecord | null> {
    return this.#rows.get(caseId) ?? null;
  }

  async listOpen(limit: number): Promise<MfciCaseRowRecord[]> {
    return [...this.#rows.values()]
      .filter((r) => r.status === 'open')
      .sort(
        (a, b) =>
          (RISK_SEVERITY[b.riskState] ?? 0) - (RISK_SEVERITY[a.riskState] ?? 0) ||
          Date.parse(b.openedAt) - Date.parse(a.openedAt),
      )
      .slice(0, limit);
  }

  async latestForTarget(targetId: string): Promise<MfciCaseRowRecord | null> {
    const rows = [...this.#rows.values()]
      .filter((r) => r.targetId === targetId)
      .sort((a, b) => Date.parse(b.openedAt) - Date.parse(a.openedAt));
    return rows[0] ?? null;
  }

  async resolve(
    caseId: string,
    status: Exclude<MfciCaseStatus, 'open'>,
    resolvedBy: string,
    resolvedAt: string,
  ): Promise<MfciCaseRowRecord | null> {
    const row = this.#rows.get(caseId);
    if (row?.status !== 'open') return null;
    const next = { ...row, status, resolvedBy, resolvedAt };
    this.#rows.set(caseId, next);
    return next;
  }

  async clear(): Promise<void> {
    this.#rows.clear();
  }
}

// ---------------------------------------------------------------------------
// MFCI conditioning margins (WS-H.3.2b / MFCI-4)
// ---------------------------------------------------------------------------

export interface MfciMarginsRecord {
  /** Content-addressed reference — what every output's fixed_margins_ref names. */
  marginsRef: string;
  windowStart: string;
  /** describeMargins() shape: axes, per-axis 1-way margins, table total. */
  margins: { axes: string[]; margins: number[][]; total: number };
  createdAt: string;
}

export interface MfciMarginsStore {
  /** Idempotent by ref (content-addressed: same table ⇒ same record). */
  put(record: MfciMarginsRecord): Promise<void>;
  get(marginsRef: string): Promise<MfciMarginsRecord | null>;
  clear(): Promise<void>;
}

export class InMemoryMfciMarginsStore implements MfciMarginsStore {
  readonly #rows = new Map<string, MfciMarginsRecord>();

  async put(record: MfciMarginsRecord): Promise<void> {
    this.#rows.set(record.marginsRef, structuredClone(record));
  }

  async get(marginsRef: string): Promise<MfciMarginsRecord | null> {
    const row = this.#rows.get(marginsRef);
    return row ? structuredClone(row) : null;
  }

  async clear(): Promise<void> {
    this.#rows.clear();
  }
}

// ---------------------------------------------------------------------------
// MFCI per-target risk states (WS-H.3.4a continuity)
// ---------------------------------------------------------------------------

export interface MfciRiskStateRecord {
  targetId: string;
  state: 'normal' | 'elevated' | 'high' | 'severe';
  score: number;
  /** Why the state last moved (or was held): the RiskTransition reason. */
  reason: string;
  updatedAt: string;
}

export interface MfciRiskStateStore {
  get(targetId: string): Promise<MfciRiskStateRecord | null>;
  set(record: MfciRiskStateRecord): Promise<void>;
  clear(): Promise<void>;
}

export class InMemoryMfciRiskStateStore implements MfciRiskStateStore {
  readonly #rows = new Map<string, MfciRiskStateRecord>();

  async get(targetId: string): Promise<MfciRiskStateRecord | null> {
    const row = this.#rows.get(targetId);
    return row ? { ...row } : null;
  }

  async set(record: MfciRiskStateRecord): Promise<void> {
    this.#rows.set(record.targetId, { ...record });
  }

  async clear(): Promise<void> {
    this.#rows.clear();
  }
}

// ---------------------------------------------------------------------------
// Session topic sequences (WS-H.6.1a) — ephemeral, privacy-preserving
// ---------------------------------------------------------------------------

export interface SessionTopicSequenceStore {
  /** Append a transition (cap enforced); refreshes the sequence's TTL. */
  append(
    sessionKey: string,
    transition: TopicTransition,
    nowMs: number,
    cap: number,
  ): Promise<void>;
  /** The live sequence for a session key (expired sequences read empty). */
  get(sessionKey: string, nowMs: number): Promise<TopicTransition[]>;
  /** All live sequences (batch holonomy tier). Keys are opaque. */
  listLive(nowMs: number): Promise<Array<{ sessionKey: string; sequence: TopicTransition[] }>>;
  /** Drop sequences idle past the TTL; returns the number removed. */
  sweepExpired(nowMs: number): Promise<number>;
  clear(): Promise<void>;
}

/** Sequences expire after this idle period (session-scoped, WS-H.6.1a). */
export const SESSION_SEQUENCE_TTL_MS = 6 * 3_600_000;

export class InMemorySessionTopicSequenceStore implements SessionTopicSequenceStore {
  readonly #rows = new Map<string, { sequence: TopicTransition[]; lastTouchedMs: number }>();

  async append(
    sessionKey: string,
    transition: TopicTransition,
    nowMs: number,
    cap: number,
  ): Promise<void> {
    const existing = this.#rows.get(sessionKey);
    const live =
      existing && nowMs - existing.lastTouchedMs <= SESSION_SEQUENCE_TTL_MS
        ? existing.sequence
        : [];
    const next = [...live, transition];
    const capped = next.length > cap ? next.slice(next.length - cap) : next;
    this.#rows.set(sessionKey, { sequence: capped, lastTouchedMs: nowMs });
  }

  async get(sessionKey: string, nowMs: number): Promise<TopicTransition[]> {
    const row = this.#rows.get(sessionKey);
    if (!row || nowMs - row.lastTouchedMs > SESSION_SEQUENCE_TTL_MS) return [];
    return [...row.sequence];
  }

  async listLive(
    nowMs: number,
  ): Promise<Array<{ sessionKey: string; sequence: TopicTransition[] }>> {
    return [...this.#rows.entries()]
      .filter(([, row]) => nowMs - row.lastTouchedMs <= SESSION_SEQUENCE_TTL_MS)
      .map(([sessionKey, row]) => ({ sessionKey, sequence: [...row.sequence] }));
  }

  async sweepExpired(nowMs: number): Promise<number> {
    let removed = 0;
    for (const [key, row] of this.#rows) {
      if (nowMs - row.lastTouchedMs > SESSION_SEQUENCE_TTL_MS) {
        this.#rows.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  async clear(): Promise<void> {
    this.#rows.clear();
  }
}
