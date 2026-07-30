// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-K store interfaces + in-memory adapters (the house pattern: abstract
// interfaces unit-tested in memory; gated Drizzle adapters swap in at boot with
// identical semantics). Immutability is enforced where the doctrine requires it:
// the registry rejects re-registering an existing (name, version) and exposes
// only a status-patch path (the card is never rewritten); data lineage and
// output records are append-only (no update path beyond linking a correction).
import type {
  AiCorrection,
  AiInventory,
  AiOutputRecord,
  AiTranslation,
  BlockedInvocationRecord,
  DataLineageRecord,
  GovernanceAdvisory,
  GovernanceProposalSummary,
  HarnessDecision,
  RegisteredModel,
  RiskAssessment,
  SummaryReport,
  TranslationReport,
} from '@licio/ai-governance';

function clone<T>(value: T): T {
  return structuredClone(value);
}

// --- WS-K.1.1b model registry ----------------------------------------------

export interface ModelRegistryStore {
  /** Insert a new (name, version). Returns null if it already exists (versions
   *  are preserved, never overwritten — WS-K.1.1b). */
  register(model: RegisteredModel): Promise<RegisteredModel | null>;
  getVersion(name: string, version: string): Promise<RegisteredModel | null>;
  listVersions(name: string): Promise<RegisteredModel[]>;
  /** The currently deployed version for a model name, if any. */
  getDeployed(name: string): Promise<RegisteredModel | null>;
  /** Patch lifecycle fields ONLY (status/deployed_at/deprecation) — never the
   *  card (so the card's append-only update_history cannot be rewritten). */
  patchStatus(
    name: string,
    version: string,
    patch: Pick<RegisteredModel, 'status' | 'deployed_at' | 'deprecation'>,
  ): Promise<RegisteredModel | null>;
  list(filter: {
    name?: string;
    purpose?: string;
    owner?: string;
    status?: RegisteredModel['status'];
  }): Promise<RegisteredModel[]>;
  clear(): Promise<void>;
}

export class InMemoryModelRegistryStore implements ModelRegistryStore {
  readonly #rows = new Map<string, RegisteredModel>();
  #key(name: string, version: string): string {
    return `${name}\x00${version}`;
  }
  async register(model: RegisteredModel): Promise<RegisteredModel | null> {
    const key = this.#key(model.name, model.version);
    if (this.#rows.has(key)) return null;
    this.#rows.set(key, clone(model));
    return clone(model);
  }
  async getVersion(name: string, version: string): Promise<RegisteredModel | null> {
    const row = this.#rows.get(this.#key(name, version));
    return row ? clone(row) : null;
  }
  async listVersions(name: string): Promise<RegisteredModel[]> {
    return [...this.#rows.values()].filter((m) => m.name === name).map(clone);
  }
  async getDeployed(name: string): Promise<RegisteredModel | null> {
    const deployed = [...this.#rows.values()]
      .filter((m) => m.name === name && m.status === 'deployed')
      .sort((a, b) => (b.deployed_at ?? '').localeCompare(a.deployed_at ?? ''))[0];
    return deployed ? clone(deployed) : null;
  }
  async patchStatus(
    name: string,
    version: string,
    patch: Pick<RegisteredModel, 'status' | 'deployed_at' | 'deprecation'>,
  ): Promise<RegisteredModel | null> {
    const key = this.#key(name, version);
    const row = this.#rows.get(key);
    if (!row) return null;
    const updated: RegisteredModel = { ...row, ...patch };
    this.#rows.set(key, clone(updated));
    return clone(updated);
  }
  async list(filter: {
    name?: string;
    purpose?: string;
    owner?: string;
    status?: RegisteredModel['status'];
  }): Promise<RegisteredModel[]> {
    return [...this.#rows.values()]
      .filter((m) => filter.name === undefined || m.name === filter.name)
      .filter((m) => filter.owner === undefined || m.card.owner === filter.owner)
      .filter((m) => filter.purpose === undefined || m.card.purpose.includes(filter.purpose))
      .filter((m) => filter.status === undefined || m.status === filter.status)
      .map(clone);
  }
  async clear(): Promise<void> {
    this.#rows.clear();
  }
}

// --- WS-K.1.1c risk assessments + inventory --------------------------------

export interface RiskAssessmentStore {
  put(assessment: RiskAssessment): Promise<void>;
  get(assessmentId: string): Promise<RiskAssessment | null>;
  list(): Promise<RiskAssessment[]>;
  clear(): Promise<void>;
}

export class InMemoryRiskAssessmentStore implements RiskAssessmentStore {
  readonly #rows = new Map<string, RiskAssessment>();
  async put(assessment: RiskAssessment): Promise<void> {
    this.#rows.set(assessment.assessment_id, clone(assessment));
  }
  async get(assessmentId: string): Promise<RiskAssessment | null> {
    const row = this.#rows.get(assessmentId);
    return row ? clone(row) : null;
  }
  async list(): Promise<RiskAssessment[]> {
    return [...this.#rows.values()].map(clone);
  }
  async clear(): Promise<void> {
    this.#rows.clear();
  }
}

export interface InventoryStore {
  /** Append a new version snapshot (append-only audit trail). */
  put(inventory: AiInventory): Promise<void>;
  latest(): Promise<AiInventory | null>;
  listVersions(): Promise<AiInventory[]>;
  clear(): Promise<void>;
}

export class InMemoryInventoryStore implements InventoryStore {
  readonly #rows = new Map<number, AiInventory>();
  async put(inventory: AiInventory): Promise<void> {
    this.#rows.set(inventory.version, clone(inventory));
  }
  async latest(): Promise<AiInventory | null> {
    const versions = [...this.#rows.keys()].sort((a, b) => b - a);
    const v = versions[0];
    return v === undefined ? null : clone(this.#rows.get(v) as AiInventory);
  }
  async listVersions(): Promise<AiInventory[]> {
    return [...this.#rows.values()].sort((a, b) => a.version - b.version).map(clone);
  }
  async clear(): Promise<void> {
    this.#rows.clear();
  }
}

// --- WS-K.1.1e data lineage (append-only) ----------------------------------

export interface DataLineageStore {
  /** Insert a new (dataset_id, version); returns null if it already exists. */
  put(record: DataLineageRecord): Promise<DataLineageRecord | null>;
  get(datasetId: string, version: string): Promise<DataLineageRecord | null>;
  /** The latest version of a dataset by semver-ish ordering of insert. */
  list(): Promise<DataLineageRecord[]>;
  clear(): Promise<void>;
}

export class InMemoryDataLineageStore implements DataLineageStore {
  readonly #rows = new Map<string, DataLineageRecord>();
  #key(datasetId: string, version: string): string {
    return `${datasetId}\x00${version}`;
  }
  async put(record: DataLineageRecord): Promise<DataLineageRecord | null> {
    const key = this.#key(record.dataset_id, record.version);
    if (this.#rows.has(key)) return null; // append-only: never overwrite
    this.#rows.set(key, clone(record));
    return clone(record);
  }
  async get(datasetId: string, version: string): Promise<DataLineageRecord | null> {
    const row = this.#rows.get(this.#key(datasetId, version));
    return row ? clone(row) : null;
  }
  async list(): Promise<DataLineageRecord[]> {
    return [...this.#rows.values()].map(clone);
  }
  async clear(): Promise<void> {
    this.#rows.clear();
  }
}

// --- WS-K.1.1f audit-sensitive output records (append-only) -----------------

export interface AiOutputRecordStore {
  put(record: AiOutputRecord): Promise<AiOutputRecord | null>;
  get(outputId: string): Promise<AiOutputRecord | null>;
  listByModel(name: string, version: string): Promise<AiOutputRecord[]>;
  listByUseCase(useCaseId: string, fromIso: string, toIso: string): Promise<AiOutputRecord[]>;
  /** Link a downstream human correction (the one permitted mutation). */
  linkCorrection(outputId: string, correctionRef: string): Promise<AiOutputRecord | null>;
  clear(): Promise<void>;
}

export class InMemoryAiOutputRecordStore implements AiOutputRecordStore {
  readonly #rows = new Map<string, AiOutputRecord>();
  async put(record: AiOutputRecord): Promise<AiOutputRecord | null> {
    if (this.#rows.has(record.output_id)) return null;
    this.#rows.set(record.output_id, clone(record));
    return clone(record);
  }
  async get(outputId: string): Promise<AiOutputRecord | null> {
    const row = this.#rows.get(outputId);
    return row ? clone(row) : null;
  }
  async listByModel(name: string, version: string): Promise<AiOutputRecord[]> {
    return [...this.#rows.values()]
      .filter((r) => r.model_name === name && r.model_version === version)
      .map(clone);
  }
  async listByUseCase(
    useCaseId: string,
    fromIso: string,
    toIso: string,
  ): Promise<AiOutputRecord[]> {
    return [...this.#rows.values()]
      .filter((r) => r.use_case_id === useCaseId && r.timestamp >= fromIso && r.timestamp <= toIso)
      .map(clone);
  }
  async linkCorrection(outputId: string, correctionRef: string): Promise<AiOutputRecord | null> {
    const row = this.#rows.get(outputId);
    if (!row) return null;
    // The only permitted mutation: linking a correction (WS-K.1.1f).
    const updated = { ...row, correction_ref: correctionRef };
    this.#rows.set(outputId, clone(updated));
    return clone(updated);
  }
  async clear(): Promise<void> {
    this.#rows.clear();
  }
}

// --- WS-K.1.2e harness evaluation decisions --------------------------------

export interface EvaluationStore {
  put(decision: HarnessDecision): Promise<void>;
  /** The latest decision for a (name, version). */
  latest(name: string, version: string): Promise<HarnessDecision | null>;
  listByModel(name: string, version: string): Promise<HarnessDecision[]>;
  clear(): Promise<void>;
}

export class InMemoryEvaluationStore implements EvaluationStore {
  readonly #rows: HarnessDecision[] = [];
  async put(decision: HarnessDecision): Promise<void> {
    this.#rows.push(clone(decision));
  }
  async latest(name: string, version: string): Promise<HarnessDecision | null> {
    const matching = this.#rows
      .filter((d) => d.model_name === name && d.version === version)
      .sort((a, b) => b.evaluated_at.localeCompare(a.evaluated_at));
    return matching[0] ? clone(matching[0]) : null;
  }
  async listByModel(name: string, version: string): Promise<HarnessDecision[]> {
    return this.#rows.filter((d) => d.model_name === name && d.version === version).map(clone);
  }
  async clear(): Promise<void> {
    this.#rows.length = 0;
  }
}

// --- WS-K.1.3c corrections --------------------------------------------------

export interface CorrectionStore {
  put(correction: AiCorrection): Promise<void>;
  listByUseCase(useCaseId: string): Promise<AiCorrection[]>;
  listByOutput(outputId: string): Promise<AiCorrection[]>;
  clear(): Promise<void>;
}

export class InMemoryCorrectionStore implements CorrectionStore {
  readonly #rows: AiCorrection[] = [];
  async put(correction: AiCorrection): Promise<void> {
    this.#rows.push(clone(correction));
  }
  async listByUseCase(useCaseId: string): Promise<AiCorrection[]> {
    return this.#rows.filter((c) => c.use_case_id === useCaseId).map(clone);
  }
  async listByOutput(outputId: string): Promise<AiCorrection[]> {
    return this.#rows.filter((c) => c.output_id === outputId).map(clone);
  }
  async clear(): Promise<void> {
    this.#rows.length = 0;
  }
}

// --- WS-K.1.1d blocked-invocation audit (append-only) -----------------------

export interface BlockedInvocationStore {
  put(record: BlockedInvocationRecord): Promise<void>;
  list(limit: number): Promise<BlockedInvocationRecord[]>;
  countByProhibition(): Promise<Record<string, number>>;
  clear(): Promise<void>;
}

export class InMemoryBlockedInvocationStore implements BlockedInvocationStore {
  readonly #rows: BlockedInvocationRecord[] = [];
  async put(record: BlockedInvocationRecord): Promise<void> {
    this.#rows.push(clone(record));
  }
  async list(limit: number): Promise<BlockedInvocationRecord[]> {
    return this.#rows
      .slice()
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
      .slice(0, limit)
      .map(clone);
  }
  async countByProhibition(): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const r of this.#rows) counts[r.prohibition] = (counts[r.prohibition] ?? 0) + 1;
    return counts;
  }
  async clear(): Promise<void> {
    this.#rows.length = 0;
  }
}

// --- WS-K review queue (low-confidence + user-reported AI outputs) ----------

export type AiReviewKind =
  | 'low_confidence_classification'
  | 'reported_summary'
  | 'reported_translation'
  | 'flagged_hallucination';

export interface AiReviewItem {
  reviewId: string;
  kind: AiReviewKind;
  /** The subject (story id, summary id, translation id, output id). */
  subjectRef: string;
  context: Record<string, unknown>;
  status: 'pending' | 'resolved';
  resolution: string | null;
  resolvedBy: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

export interface AiReviewQueueStore {
  insert(item: Omit<AiReviewItem, 'reviewId' | 'createdAt' | 'resolvedAt'>): Promise<AiReviewItem>;
  get(reviewId: string): Promise<AiReviewItem | null>;
  list(
    filter: { status?: AiReviewItem['status']; kind?: AiReviewKind },
    limit: number,
  ): Promise<AiReviewItem[]>;
  resolve(
    reviewId: string,
    resolution: string,
    resolvedBy: string,
    atIso: string,
  ): Promise<AiReviewItem | null>;
  clear(): Promise<void>;
}

export class InMemoryAiReviewQueueStore implements AiReviewQueueStore {
  readonly #rows = new Map<string, AiReviewItem>();
  #seq = 0;
  async insert(
    item: Omit<AiReviewItem, 'reviewId' | 'createdAt' | 'resolvedAt'>,
  ): Promise<AiReviewItem> {
    // Mirrors `ai_review_queue_pending_subject_uq`: at most ONE pending item
    // per (kind, subject).  The report routes are what write here, and an
    // adapter more permissive than the database would let a defect pass every
    // unit test and only surface against live Postgres.
    if (item.status === 'pending') {
      for (const existing of this.#rows.values()) {
        if (
          existing.status === 'pending' &&
          existing.kind === item.kind &&
          existing.subjectRef === item.subjectRef
        ) {
          return clone(existing);
        }
      }
    }
    this.#seq += 1;
    const record: AiReviewItem = {
      ...item,
      reviewId: `airev-${this.#seq}`,
      createdAt: new Date().toISOString(),
      resolvedAt: null,
    };
    this.#rows.set(record.reviewId, clone(record));
    return clone(record);
  }
  async get(reviewId: string): Promise<AiReviewItem | null> {
    const row = this.#rows.get(reviewId);
    return row ? clone(row) : null;
  }
  async list(
    filter: { status?: AiReviewItem['status']; kind?: AiReviewKind },
    limit: number,
  ): Promise<AiReviewItem[]> {
    return [...this.#rows.values()]
      .filter((r) => filter.status === undefined || r.status === filter.status)
      .filter((r) => filter.kind === undefined || r.kind === filter.kind)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(0, limit)
      .map(clone);
  }
  async resolve(
    reviewId: string,
    resolution: string,
    resolvedBy: string,
    atIso: string,
  ): Promise<AiReviewItem | null> {
    const row = this.#rows.get(reviewId);
    if (!row) return null;
    const updated: AiReviewItem = {
      ...row,
      status: 'resolved',
      resolution,
      resolvedBy,
      resolvedAt: atIso,
    };
    this.#rows.set(reviewId, clone(updated));
    return clone(updated);
  }
  async clear(): Promise<void> {
    this.#rows.clear();
  }
}

// --- WS-K.1.4 summary drafts + reports -------------------------------------

export interface SummaryDraftRecord {
  summaryId: string;
  threadId: string;
  draft: Record<string, unknown>;
  outputId: string;
  qualityPassed: boolean;
  createdAt: string;
}

export interface SummaryStore {
  putDraft(record: SummaryDraftRecord): Promise<void>;
  getDraft(summaryId: string): Promise<SummaryDraftRecord | null>;
  /** The most recent draft for a thread, or null when it has never been
   *  summarized.  The sweep reads this to decide whether a thread is due; the
   *  `ai_summary_drafts_thread_idx` index that supports it already existed with
   *  no query behind it. */
  getLatestForThread(threadId: string): Promise<SummaryDraftRecord | null>;
  putReport(report: SummaryReport): Promise<void>;
  /**
   * The NEWEST `limit` reports for one summary.
   *
   * The limit is REQUIRED, and newest-first is the store's own order rather
   * than the caller's, because the unbounded version was the defect: the review
   * queue read every report row for up to 100 subjects concurrently just to
   * report a count, so the response was bounded while the READ was not — and
   * nothing prunes these tables, so any authenticated account could grow one
   * subject's reports without limit and take the only surface that shows
   * reports to a steward down permanently.  A caller that wants the total asks
   * `countReports`.
   */
  listReports(summaryId: string, limit: number): Promise<SummaryReport[]>;
  /** How many reports one summary has — the figure a steward triages on,
   *  answered without materializing the rows. */
  countReports(summaryId: string): Promise<number>;
  countReportsByReason(): Promise<Record<string, number>>;
  clear(): Promise<void>;
}

export class InMemorySummaryStore implements SummaryStore {
  readonly #drafts = new Map<string, SummaryDraftRecord>();
  readonly #reports: SummaryReport[] = [];
  async putDraft(record: SummaryDraftRecord): Promise<void> {
    this.#drafts.set(record.summaryId, clone(record));
  }
  async getDraft(summaryId: string): Promise<SummaryDraftRecord | null> {
    const row = this.#drafts.get(summaryId);
    return row ? clone(row) : null;
  }
  async getLatestForThread(threadId: string): Promise<SummaryDraftRecord | null> {
    let latest: SummaryDraftRecord | null = null;
    for (const row of this.#drafts.values()) {
      if (row.threadId !== threadId) continue;
      // Tie-break on summaryId so equal timestamps still give ONE answer —
      // the same total-order discipline the Drizzle adapter's ORDER BY needs.
      if (
        latest === null ||
        row.createdAt > latest.createdAt ||
        (row.createdAt === latest.createdAt && row.summaryId > latest.summaryId)
      ) {
        latest = row;
      }
    }
    return latest ? clone(latest) : null;
  }
  async putReport(report: SummaryReport): Promise<void> {
    this.#reports.push(clone(report));
  }
  async listReports(summaryId: string, limit: number): Promise<SummaryReport[]> {
    return this.#reports
      .filter((r) => r.summary_id === summaryId)
      .sort((x, y) => y.reported_at.localeCompare(x.reported_at))
      .slice(0, Math.max(0, limit))
      .map(clone);
  }
  async countReports(summaryId: string): Promise<number> {
    return this.#reports.filter((r) => r.summary_id === summaryId).length;
  }
  async countReportsByReason(): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const r of this.#reports) counts[r.reason] = (counts[r.reason] ?? 0) + 1;
    return counts;
  }
  async clear(): Promise<void> {
    this.#drafts.clear();
    this.#reports.length = 0;
  }
}

// --- WS-K.2.1a translations + reports --------------------------------------

export interface TranslationStore {
  put(translation: AiTranslation): Promise<void>;
  get(translationId: string): Promise<AiTranslation | null>;
  findBySource(sourceRef: string, targetLang: string): Promise<AiTranslation | null>;
  putReport(report: TranslationReport): Promise<void>;
  /** The NEWEST `limit` reports for one translation — see
   *  `SummaryStore.listReports` for why the bound is not optional. */
  listReports(translationId: string, limit: number): Promise<TranslationReport[]>;
  /** How many reports one translation has, without materializing the rows. */
  countReports(translationId: string): Promise<number>;
  clear(): Promise<void>;
}

export class InMemoryTranslationStore implements TranslationStore {
  readonly #rows = new Map<string, AiTranslation>();
  readonly #reports: TranslationReport[] = [];
  async put(translation: AiTranslation): Promise<void> {
    this.#rows.set(translation.translation_id, clone(translation));
  }
  async get(translationId: string): Promise<AiTranslation | null> {
    const row = this.#rows.get(translationId);
    return row ? clone(row) : null;
  }
  async findBySource(sourceRef: string, targetLang: string): Promise<AiTranslation | null> {
    const row = [...this.#rows.values()].find(
      (t) => t.source_ref === sourceRef && t.target_lang === targetLang,
    );
    return row ? clone(row) : null;
  }
  async putReport(report: TranslationReport): Promise<void> {
    this.#reports.push(clone(report));
  }
  async listReports(translationId: string, limit: number): Promise<TranslationReport[]> {
    return this.#reports
      .filter((r) => r.translation_id === translationId)
      .sort((x, y) => y.reported_at.localeCompare(x.reported_at))
      .slice(0, Math.max(0, limit))
      .map(clone);
  }
  async countReports(translationId: string): Promise<number> {
    return this.#reports.filter((r) => r.translation_id === translationId).length;
  }
  async clear(): Promise<void> {
    this.#rows.clear();
    this.#reports.length = 0;
  }
}

// --- WS-K.2.2a governance proposal summaries -------------------------------

/** Where a maintenance sweep resumes; null ⇒ start from the newest page. */
export interface SweepCursor {
  readonly createdAt: string;
  readonly ref: string;
}

/**
 * The durable position of a maintenance sweep (WS-K.1.4a).
 *
 * The hourly tick runs under a DISTRIBUTED lease, so an in-process cursor is
 * lost to every restart, deploy, and lease handover — resetting the sweep to
 * the newest page.  At one page an hour a large installation is reset long
 * before it reaches the tail, so the older threads the sweep exists to
 * summarize are never reached: the same permanent gap the cursor closed, one
 * layer up.
 */
export interface SweepCursorStore {
  get(sweepName: string): Promise<SweepCursor | null>;
  /** `null` rewinds to the newest page (the tail was reached). */
  set(sweepName: string, cursor: SweepCursor | null): Promise<void>;
  clear(): Promise<void>;
}

export class InMemorySweepCursorStore implements SweepCursorStore {
  readonly #rows = new Map<string, SweepCursor>();
  async get(sweepName: string): Promise<SweepCursor | null> {
    const row = this.#rows.get(sweepName);
    return row ? { ...row } : null;
  }
  async set(sweepName: string, cursor: SweepCursor | null): Promise<void> {
    if (cursor === null) this.#rows.delete(sweepName);
    else this.#rows.set(sweepName, { ...cursor });
  }
  async clear(): Promise<void> {
    this.#rows.clear();
  }
}

/**
 * The §24.5 governance ADVISORIES a steward reads before deciding.
 *
 * `highlightConflictOfInterest` and `detectScamPatterns` produced a concrete
 * advisory and the production caller discarded the value — no store, no route,
 * no reader — so the advice the wiring claimed to provide reached nobody.
 * "Advisory" only means anything when someone can see the advice and knowingly
 * ignore it; unread advice is not restraint, it is absence.
 */
export interface GovernanceAdvisoryStore {
  put(advisory: GovernanceAdvisory): Promise<void>;
  listByProposal(proposalRef: string): Promise<GovernanceAdvisory[]>;
  clear(): Promise<void>;
}

export class InMemoryGovernanceAdvisoryStore implements GovernanceAdvisoryStore {
  readonly #rows = new Map<string, GovernanceAdvisory>();
  async put(advisory: GovernanceAdvisory): Promise<void> {
    this.#rows.set(advisory.advisory_id, clone(advisory));
  }
  async listByProposal(proposalRef: string): Promise<GovernanceAdvisory[]> {
    return [...this.#rows.values()]
      .filter((a) => a.proposal_ref === proposalRef)
      .sort(
        (a, b) =>
          a.generated_at.localeCompare(b.generated_at) ||
          a.advisory_id.localeCompare(b.advisory_id),
      )
      .map(clone);
  }
  async clear(): Promise<void> {
    this.#rows.clear();
  }
}

export interface GovernanceSummaryStore {
  put(summary: GovernanceProposalSummary): Promise<void>;
  get(summaryId: string): Promise<GovernanceProposalSummary | null>;
  listByProposal(proposalRef: string): Promise<GovernanceProposalSummary[]>;
  clear(): Promise<void>;
}

export class InMemoryGovernanceSummaryStore implements GovernanceSummaryStore {
  readonly #rows = new Map<string, GovernanceProposalSummary>();
  async put(summary: GovernanceProposalSummary): Promise<void> {
    this.#rows.set(summary.summary_id, clone(summary));
  }
  async get(summaryId: string): Promise<GovernanceProposalSummary | null> {
    const row = this.#rows.get(summaryId);
    return row ? clone(row) : null;
  }
  async listByProposal(proposalRef: string): Promise<GovernanceProposalSummary[]> {
    return [...this.#rows.values()].filter((s) => s.proposal_ref === proposalRef).map(clone);
  }
  async clear(): Promise<void> {
    this.#rows.clear();
  }
}

// --- WS-K.1.2f runtime monitoring ------------------------------------------

export interface RuntimeMetricPoint {
  modelName: string;
  modelVersion: string;
  metric: string;
  value: number;
  recordedAt: string;
}

export interface RuntimeAlertRecord {
  modelName: string;
  modelVersion: string;
  metric: string;
  value: number;
  threshold: number;
  rollbackRecommendation: string | null;
  raisedAt: string;
}

export interface RuntimeMonitorStore {
  recordMetric(point: RuntimeMetricPoint): Promise<void>;
  listMetrics(modelName: string, metric: string, sinceIso: string): Promise<RuntimeMetricPoint[]>;
  recordAlert(alert: RuntimeAlertRecord): Promise<void>;
  listAlerts(limit: number): Promise<RuntimeAlertRecord[]>;
  clear(): Promise<void>;
}

export class InMemoryRuntimeMonitorStore implements RuntimeMonitorStore {
  readonly #metrics: RuntimeMetricPoint[] = [];
  readonly #alerts: RuntimeAlertRecord[] = [];
  async recordMetric(point: RuntimeMetricPoint): Promise<void> {
    this.#metrics.push(clone(point));
  }
  async listMetrics(
    modelName: string,
    metric: string,
    sinceIso: string,
  ): Promise<RuntimeMetricPoint[]> {
    return this.#metrics
      .filter((m) => m.modelName === modelName && m.metric === metric && m.recordedAt >= sinceIso)
      .map(clone);
  }
  async recordAlert(alert: RuntimeAlertRecord): Promise<void> {
    this.#alerts.push(clone(alert));
  }
  async listAlerts(limit: number): Promise<RuntimeAlertRecord[]> {
    return this.#alerts
      .slice()
      .sort((a, b) => b.raisedAt.localeCompare(a.raisedAt))
      .slice(0, limit)
      .map(clone);
  }
  async clear(): Promise<void> {
    this.#metrics.length = 0;
    this.#alerts.length = 0;
  }
}

// --- WS-U in-room moderation decision log (ADR-9) --------------------------
//
// The append-only observability log for the in-room LLM moderation MODEL: each
// decision records what the model PROPOSED and what the deterministic wrapper
// (escalate-to-review ceiling + capability clamp) actually PERMITTED, so an
// operator can see how often the wrapper reduced the model (the transparency of
// bounded autonomy). Metadata only: no content text, no attention values, no
// user identity beyond the contribution ref the audit log already carries.

export interface ModerationDecisionRecord {
  recordId: string;
  roomId: string;
  /** The moderated contribution id (matches the agent-action audit log). */
  subjectRef: string;
  /** The model's RAW proposed action (before the deterministic wrapper). */
  proposedAction: string;
  /** The action the wrapper actually permitted (ceiling + capability clamp). */
  boundedAction: string;
  /** True when the ceiling and/or capability clamp reduced the model's proposal. */
  clamped: boolean;
  /** The AIOutputRecord id of the invocation (provenance); null if none. */
  outputId: string | null;
  createdAt: string;
}

export interface ModerationDecisionSummary {
  total: number;
  allowed: number;
  warned: number;
  flaggedForReview: number;
  /** Rows where the deterministic wrapper reduced the model's proposal. */
  clampedByWrapper: number;
}

export interface ModerationDecisionLogStore {
  append(record: ModerationDecisionRecord): Promise<void>;
  listByRoom(roomId: string, limit: number): Promise<ModerationDecisionRecord[]>;
  summaryByRoom(roomId: string): Promise<ModerationDecisionSummary>;
  clear(): Promise<void>;
}

/** In-memory adapter (dev/tests; a gated Drizzle adapter is a tracked
 *  follow-up). Bounded per room so a long-running dev process cannot grow it
 *  without limit; the oldest rows are dropped past the cap. */
export class InMemoryModerationDecisionLog implements ModerationDecisionLogStore {
  static readonly PER_ROOM_CAP = 1000;
  readonly #byRoom = new Map<string, ModerationDecisionRecord[]>();

  async append(record: ModerationDecisionRecord): Promise<void> {
    const list = this.#byRoom.get(record.roomId) ?? [];
    list.push(clone(record));
    if (list.length > InMemoryModerationDecisionLog.PER_ROOM_CAP) list.shift();
    this.#byRoom.set(record.roomId, list);
  }

  async listByRoom(roomId: string, limit: number): Promise<ModerationDecisionRecord[]> {
    return (this.#byRoom.get(roomId) ?? [])
      .slice()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map(clone);
  }

  async summaryByRoom(roomId: string): Promise<ModerationDecisionSummary> {
    const list = this.#byRoom.get(roomId) ?? [];
    let allowed = 0;
    let warned = 0;
    let flaggedForReview = 0;
    let clampedByWrapper = 0;
    for (const r of list) {
      if (r.boundedAction === 'allow') allowed += 1;
      else if (r.boundedAction === 'warn') warned += 1;
      else if (r.boundedAction === 'flag_for_review') flaggedForReview += 1;
      if (r.clamped) clampedByWrapper += 1;
    }
    return { total: list.length, allowed, warned, flaggedForReview, clampedByWrapper };
  }

  async clear(): Promise<void> {
    this.#byRoom.clear();
  }
}
