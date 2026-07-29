// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Production Postgres adapters for the WS-K stores, behind the same interfaces
// as the in-memory adapters (the WS-D/E/F/G house policy).  Immutability is
// preserved structurally: the registry INSERTs conflict-DO-NOTHING on
// (name, version) and exposes only the status-patch UPDATE (the card is never
// rewritten); data lineage and output records are append-only (the single
// permitted mutation is linking a correction); blocked invocations and the
// WS-U moderation decision log are append-only observability.  Domain objects
// with rich nested payloads (model card, risk assessment, inventory, lineage,
// harness decision, governance summary) persist whole as JSONB alongside the
// mirrored indexed columns, so a read returns exactly what was written with no
// field-mapping drift; flat records map column-per-field.

import { randomUUID } from 'node:crypto';
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
import {
  aiBlockedInvocations,
  aiCorrections,
  aiDataLineage,
  aiEvaluations,
  aiGovernanceAdvisories,
  aiGovernanceSummaries,
  aiInventoryVersions,
  aiModelCards,
  aiModerationDecisions,
  aiOutputRecords,
  aiReviewQueue,
  aiRiskAssessments,
  aiRuntimeAlerts,
  aiRuntimeMetrics,
  aiSummaryDrafts,
  aiSummaryReports,
  aiSweepCursors,
  aiTranslationReports,
  aiTranslations,
  type createDbClient,
} from '@licio/db';
import { and, asc, desc, eq, gte, lte, sql } from 'drizzle-orm';
import type {
  AiOutputRecordStore,
  AiReviewItem,
  AiReviewKind,
  AiReviewQueueStore,
  BlockedInvocationStore,
  CorrectionStore,
  DataLineageStore,
  EvaluationStore,
  GovernanceAdvisoryStore,
  GovernanceSummaryStore,
  InventoryStore,
  ModelRegistryStore,
  ModerationDecisionLogStore,
  ModerationDecisionRecord,
  ModerationDecisionSummary,
  RiskAssessmentStore,
  RuntimeAlertRecord,
  RuntimeMetricPoint,
  RuntimeMonitorStore,
  SummaryDraftRecord,
  SummaryStore,
  SweepCursor,
  SweepCursorStore,
  TranslationStore,
} from './stores.js';

type Db = ReturnType<typeof createDbClient>;

const iso = (d: Date): string => d.toISOString();
/** JSONB casts for zod-inferred object types (no index signature). */
const asJson = (value: unknown): Record<string, unknown> => value as Record<string, unknown>;

// --- WS-K.1.1b model registry ----------------------------------------------

export class DrizzleModelRegistryStore implements ModelRegistryStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  #toModel(row: typeof aiModelCards.$inferSelect): RegisteredModel {
    return {
      name: row.name,
      version: row.version,
      card: row.card as RegisteredModel['card'],
      status: row.status as RegisteredModel['status'],
      deprecation: (row.deprecation ?? null) as RegisteredModel['deprecation'],
      registered_at: iso(row.registeredAt),
      deployed_at: row.deployedAt ? iso(row.deployedAt) : null,
    };
  }

  async register(model: RegisteredModel): Promise<RegisteredModel | null> {
    const rows = await this.#db
      .insert(aiModelCards)
      .values({
        name: model.name,
        version: model.version,
        card: asJson(model.card),
        status: model.status,
        deprecation: model.deprecation === null ? null : asJson(model.deprecation),
        registeredAt: new Date(model.registered_at),
        deployedAt: model.deployed_at === null ? null : new Date(model.deployed_at),
      })
      .onConflictDoNothing()
      .returning();
    const row = rows[0];
    return row ? this.#toModel(row) : null;
  }

  async getVersion(name: string, version: string): Promise<RegisteredModel | null> {
    const rows = await this.#db
      .select()
      .from(aiModelCards)
      .where(and(eq(aiModelCards.name, name), eq(aiModelCards.version, version)))
      .limit(1);
    return rows[0] ? this.#toModel(rows[0]) : null;
  }

  async listVersions(name: string): Promise<RegisteredModel[]> {
    const rows = await this.#db
      .select()
      .from(aiModelCards)
      .where(eq(aiModelCards.name, name))
      .orderBy(asc(aiModelCards.registeredAt), asc(aiModelCards.version));
    return rows.map((row) => this.#toModel(row));
  }

  async getDeployed(name: string): Promise<RegisteredModel | null> {
    const rows = await this.#db
      .select()
      .from(aiModelCards)
      .where(and(eq(aiModelCards.name, name), eq(aiModelCards.status, 'deployed')))
      .orderBy(desc(aiModelCards.deployedAt))
      .limit(1);
    return rows[0] ? this.#toModel(rows[0]) : null;
  }

  async patchStatus(
    name: string,
    version: string,
    patch: Pick<RegisteredModel, 'status' | 'deployed_at' | 'deprecation'>,
  ): Promise<RegisteredModel | null> {
    const rows = await this.#db
      .update(aiModelCards)
      .set({
        status: patch.status,
        deployedAt: patch.deployed_at === null ? null : new Date(patch.deployed_at),
        deprecation: patch.deprecation === null ? null : asJson(patch.deprecation),
      })
      .where(and(eq(aiModelCards.name, name), eq(aiModelCards.version, version)))
      .returning();
    return rows[0] ? this.#toModel(rows[0]) : null;
  }

  async list(filter: {
    name?: string;
    purpose?: string;
    owner?: string;
    status?: RegisteredModel['status'];
  }): Promise<RegisteredModel[]> {
    const conditions = [];
    if (filter.name !== undefined) conditions.push(eq(aiModelCards.name, filter.name));
    if (filter.status !== undefined) conditions.push(eq(aiModelCards.status, filter.status));
    if (filter.owner !== undefined) {
      conditions.push(sql`${aiModelCards.card}->>'owner' = ${filter.owner}`);
    }
    if (filter.purpose !== undefined) {
      // Escape LIKE metacharacters so % and _ are matched literally — this makes
      // the Drizzle result set equal the in-memory `card.purpose.includes(...)`
      // literal-substring semantics for the same input (still parameterized).
      const escaped = filter.purpose.replace(/[\\%_]/g, (ch) => `\\${ch}`);
      conditions.push(
        sql`${aiModelCards.card}->>'purpose' like '%' || ${escaped} || '%' escape '\\'`,
      );
    }
    const rows = await this.#db
      .select()
      .from(aiModelCards)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(asc(aiModelCards.registeredAt), asc(aiModelCards.version));
    return rows.map((row) => this.#toModel(row));
  }

  async clear(): Promise<void> {
    await this.#db.delete(aiModelCards);
  }
}

// --- WS-K.1.1c risk assessments + inventory --------------------------------

export class DrizzleRiskAssessmentStore implements RiskAssessmentStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  async put(assessment: RiskAssessment): Promise<void> {
    await this.#db
      .insert(aiRiskAssessments)
      .values({
        assessmentId: assessment.assessment_id,
        useCaseId: assessment.use_case_id,
        assessment: asJson(assessment),
      })
      .onConflictDoUpdate({
        target: aiRiskAssessments.assessmentId,
        set: { useCaseId: assessment.use_case_id, assessment: asJson(assessment) },
      });
  }

  async get(assessmentId: string): Promise<RiskAssessment | null> {
    const rows = await this.#db
      .select()
      .from(aiRiskAssessments)
      .where(eq(aiRiskAssessments.assessmentId, assessmentId))
      .limit(1);
    return rows[0] ? (rows[0].assessment as RiskAssessment) : null;
  }

  async list(): Promise<RiskAssessment[]> {
    const rows = await this.#db
      .select()
      .from(aiRiskAssessments)
      .orderBy(asc(aiRiskAssessments.createdAt), asc(aiRiskAssessments.assessmentId));
    return rows.map((row) => row.assessment as RiskAssessment);
  }

  async clear(): Promise<void> {
    await this.#db.delete(aiRiskAssessments);
  }
}

export class DrizzleInventoryStore implements InventoryStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  async put(inventory: AiInventory): Promise<void> {
    await this.#db
      .insert(aiInventoryVersions)
      .values({ version: inventory.version, inventory: asJson(inventory) })
      .onConflictDoUpdate({
        target: aiInventoryVersions.version,
        set: { inventory: asJson(inventory), updatedAt: new Date() },
      });
  }

  async latest(): Promise<AiInventory | null> {
    const rows = await this.#db
      .select()
      .from(aiInventoryVersions)
      .orderBy(desc(aiInventoryVersions.version))
      .limit(1);
    return rows[0] ? (rows[0].inventory as AiInventory) : null;
  }

  async listVersions(): Promise<AiInventory[]> {
    const rows = await this.#db
      .select()
      .from(aiInventoryVersions)
      .orderBy(asc(aiInventoryVersions.version));
    return rows.map((row) => row.inventory as AiInventory);
  }

  async clear(): Promise<void> {
    await this.#db.delete(aiInventoryVersions);
  }
}

// --- WS-K.1.1e data lineage (append-only) ----------------------------------

export class DrizzleDataLineageStore implements DataLineageStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  async put(record: DataLineageRecord): Promise<DataLineageRecord | null> {
    const rows = await this.#db
      .insert(aiDataLineage)
      .values({
        datasetId: record.dataset_id,
        version: record.version,
        record: asJson(record),
        containsUserDerived: record.contains_user_derived,
        usable: record.usable,
        privacyReviewRef: record.privacy_review_ref,
        predecessorDatasetId: record.predecessor_dataset_id,
        createdAt: new Date(record.created_at),
      })
      .onConflictDoNothing()
      .returning();
    return rows[0] ? (rows[0].record as DataLineageRecord) : null;
  }

  async get(datasetId: string, version: string): Promise<DataLineageRecord | null> {
    const rows = await this.#db
      .select()
      .from(aiDataLineage)
      .where(and(eq(aiDataLineage.datasetId, datasetId), eq(aiDataLineage.version, version)))
      .limit(1);
    return rows[0] ? (rows[0].record as DataLineageRecord) : null;
  }

  async list(): Promise<DataLineageRecord[]> {
    const rows = await this.#db
      .select()
      .from(aiDataLineage)
      .orderBy(asc(aiDataLineage.createdAt), asc(aiDataLineage.datasetId));
    return rows.map((row) => row.record as DataLineageRecord);
  }

  async clear(): Promise<void> {
    await this.#db.delete(aiDataLineage);
  }
}

// --- WS-K.1.1f audit-sensitive output records (append-only) -----------------

export class DrizzleAiOutputRecordStore implements AiOutputRecordStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  #toRecord(row: typeof aiOutputRecords.$inferSelect): AiOutputRecord {
    return {
      output_id: row.outputId,
      model_name: row.modelName,
      model_version: row.modelVersion,
      prompt_template_id: row.promptTemplateId,
      config_hash: row.configHash,
      input_refs: row.inputRefs,
      output_ref: row.outputRef,
      use_case_id: row.useCaseId as AiOutputRecord['use_case_id'],
      correction_ref: row.correctionRef ?? null,
      timestamp: iso(row.createdAt),
    };
  }

  async put(record: AiOutputRecord): Promise<AiOutputRecord | null> {
    const rows = await this.#db
      .insert(aiOutputRecords)
      .values({
        outputId: record.output_id,
        modelName: record.model_name,
        modelVersion: record.model_version,
        promptTemplateId: record.prompt_template_id,
        configHash: record.config_hash,
        inputRefs: [...record.input_refs],
        outputRef: record.output_ref,
        useCaseId: record.use_case_id,
        correctionRef: record.correction_ref,
        createdAt: new Date(record.timestamp),
      })
      .onConflictDoNothing()
      .returning();
    return rows[0] ? this.#toRecord(rows[0]) : null;
  }

  async get(outputId: string): Promise<AiOutputRecord | null> {
    const rows = await this.#db
      .select()
      .from(aiOutputRecords)
      .where(eq(aiOutputRecords.outputId, outputId))
      .limit(1);
    return rows[0] ? this.#toRecord(rows[0]) : null;
  }

  async listByModel(name: string, version: string): Promise<AiOutputRecord[]> {
    const rows = await this.#db
      .select()
      .from(aiOutputRecords)
      .where(and(eq(aiOutputRecords.modelName, name), eq(aiOutputRecords.modelVersion, version)))
      .orderBy(asc(aiOutputRecords.createdAt), asc(aiOutputRecords.outputId));
    return rows.map((row) => this.#toRecord(row));
  }

  async listByUseCase(
    useCaseId: string,
    fromIso: string,
    toIso: string,
  ): Promise<AiOutputRecord[]> {
    const rows = await this.#db
      .select()
      .from(aiOutputRecords)
      .where(
        and(
          eq(aiOutputRecords.useCaseId, useCaseId),
          gte(aiOutputRecords.createdAt, new Date(fromIso)),
          lte(aiOutputRecords.createdAt, new Date(toIso)),
        ),
      )
      .orderBy(asc(aiOutputRecords.createdAt), asc(aiOutputRecords.outputId));
    return rows.map((row) => this.#toRecord(row));
  }

  async linkCorrection(outputId: string, correctionRef: string): Promise<AiOutputRecord | null> {
    // The only permitted mutation: linking a correction (WS-K.1.1f).
    const rows = await this.#db
      .update(aiOutputRecords)
      .set({ correctionRef })
      .where(eq(aiOutputRecords.outputId, outputId))
      .returning();
    return rows[0] ? this.#toRecord(rows[0]) : null;
  }

  async clear(): Promise<void> {
    await this.#db.delete(aiOutputRecords);
  }
}

// --- WS-K.1.2e harness evaluation decisions --------------------------------

export class DrizzleEvaluationStore implements EvaluationStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  async put(decision: HarnessDecision): Promise<void> {
    await this.#db.insert(aiEvaluations).values({
      modelName: decision.model_name,
      modelVersion: decision.version,
      decision: decision.decision,
      decisionData: asJson(decision),
      evaluatedAt: new Date(decision.evaluated_at),
    });
  }

  async latest(name: string, version: string): Promise<HarnessDecision | null> {
    const rows = await this.#db
      .select()
      .from(aiEvaluations)
      .where(and(eq(aiEvaluations.modelName, name), eq(aiEvaluations.modelVersion, version)))
      .orderBy(desc(aiEvaluations.evaluatedAt))
      .limit(1);
    return rows[0] ? (rows[0].decisionData as HarnessDecision) : null;
  }

  async listByModel(name: string, version: string): Promise<HarnessDecision[]> {
    const rows = await this.#db
      .select()
      .from(aiEvaluations)
      .where(and(eq(aiEvaluations.modelName, name), eq(aiEvaluations.modelVersion, version)))
      .orderBy(asc(aiEvaluations.evaluatedAt));
    return rows.map((row) => row.decisionData as HarnessDecision);
  }

  async clear(): Promise<void> {
    await this.#db.delete(aiEvaluations);
  }
}

// --- WS-K.1.3c corrections --------------------------------------------------

export class DrizzleCorrectionStore implements CorrectionStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  #toCorrection(row: typeof aiCorrections.$inferSelect): AiCorrection {
    return {
      correction_id: row.correctionId,
      output_id: row.outputId,
      use_case_id: row.useCaseId as AiCorrection['use_case_id'],
      action: row.action as AiCorrection['action'],
      original_value: row.originalValue,
      corrected_value: row.correctedValue ?? null,
      steward_ref: row.stewardRef,
      category: row.category ?? null,
      corrected_at: iso(row.createdAt),
    };
  }

  async put(correction: AiCorrection): Promise<void> {
    await this.#db.insert(aiCorrections).values({
      correctionId: correction.correction_id,
      outputId: correction.output_id,
      useCaseId: correction.use_case_id,
      action: correction.action,
      originalValue: correction.original_value,
      correctedValue: correction.corrected_value,
      stewardRef: correction.steward_ref,
      category: correction.category,
      createdAt: new Date(correction.corrected_at),
    });
  }

  async listByUseCase(useCaseId: string): Promise<AiCorrection[]> {
    const rows = await this.#db
      .select()
      .from(aiCorrections)
      .where(eq(aiCorrections.useCaseId, useCaseId))
      .orderBy(asc(aiCorrections.createdAt), asc(aiCorrections.correctionId));
    return rows.map((row) => this.#toCorrection(row));
  }

  async listByOutput(outputId: string): Promise<AiCorrection[]> {
    const rows = await this.#db
      .select()
      .from(aiCorrections)
      .where(eq(aiCorrections.outputId, outputId))
      .orderBy(asc(aiCorrections.createdAt), asc(aiCorrections.correctionId));
    return rows.map((row) => this.#toCorrection(row));
  }

  async clear(): Promise<void> {
    await this.#db.delete(aiCorrections);
  }
}

// --- WS-K.1.1d blocked-invocation audit (append-only) -----------------------

export class DrizzleBlockedInvocationStore implements BlockedInvocationStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  async put(record: BlockedInvocationRecord): Promise<void> {
    await this.#db.insert(aiBlockedInvocations).values({
      blockId: record.block_id,
      prohibition: record.prohibition,
      useCaseId: record.use_case_id,
      capability: record.capability,
      caller: record.caller,
      contextRef: record.context_ref,
      reason: record.reason,
      createdAt: new Date(record.timestamp),
    });
  }

  async list(limit: number): Promise<BlockedInvocationRecord[]> {
    const rows = await this.#db
      .select()
      .from(aiBlockedInvocations)
      .orderBy(desc(aiBlockedInvocations.createdAt), desc(aiBlockedInvocations.blockId))
      .limit(limit);
    return rows.map((row) => ({
      block_id: row.blockId,
      prohibition: row.prohibition as BlockedInvocationRecord['prohibition'],
      use_case_id: row.useCaseId as BlockedInvocationRecord['use_case_id'],
      capability: row.capability as BlockedInvocationRecord['capability'],
      caller: row.caller,
      context_ref: row.contextRef ?? null,
      reason: row.reason,
      timestamp: iso(row.createdAt),
    }));
  }

  async countByProhibition(): Promise<Record<string, number>> {
    const rows = await this.#db
      .select({
        prohibition: aiBlockedInvocations.prohibition,
        count: sql<number>`count(*)::int`,
      })
      .from(aiBlockedInvocations)
      .groupBy(aiBlockedInvocations.prohibition);
    return Object.fromEntries(rows.map((row) => [row.prohibition, row.count]));
  }

  async clear(): Promise<void> {
    await this.#db.delete(aiBlockedInvocations);
  }
}

// --- WS-K review queue (low-confidence + user-reported AI outputs) ----------

export class DrizzleAiReviewQueueStore implements AiReviewQueueStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  #toItem(row: typeof aiReviewQueue.$inferSelect): AiReviewItem {
    return {
      reviewId: row.reviewId,
      kind: row.kind as AiReviewKind,
      subjectRef: row.subjectRef,
      context: row.context,
      status: row.status as AiReviewItem['status'],
      resolution: row.resolution ?? null,
      resolvedBy: row.resolvedBy ?? null,
      createdAt: iso(row.createdAt),
      resolvedAt: row.resolvedAt ? iso(row.resolvedAt) : null,
    };
  }

  async insert(
    item: Omit<AiReviewItem, 'reviewId' | 'createdAt' | 'resolvedAt'>,
  ): Promise<AiReviewItem> {
    const rows = await this.#db
      .insert(aiReviewQueue)
      .values({
        reviewId: `airev-${randomUUID()}`,
        kind: item.kind,
        subjectRef: item.subjectRef,
        context: item.context,
        status: item.status,
        resolution: item.resolution,
        resolvedBy: item.resolvedBy,
        createdAt: new Date(),
        resolvedAt: null,
      })
      // One PENDING item per (kind, subject) — `ai_review_queue_pending_subject_uq`.
      // A repeat report is not an error and must not 500 the route; it adds to
      // the report COUNT (recorded in the report tables) without adding a
      // second queue entry a steward has to triage.
      .onConflictDoNothing()
      .returning();
    const row = rows[0];
    if (row) return this.#toItem(row);
    const incumbent = await this.#db
      .select()
      .from(aiReviewQueue)
      .where(
        and(
          eq(aiReviewQueue.kind, item.kind),
          eq(aiReviewQueue.subjectRef, item.subjectRef),
          eq(aiReviewQueue.status, 'pending'),
        ),
      )
      .limit(1);
    const existing = incumbent[0];
    if (existing) return this.#toItem(existing);
    // The incumbent was RESOLVED between the conflicting insert and this read.
    // The partial index only covers `pending`, so the row that blocked us is no
    // longer in the way — retry once and the insert now succeeds.  Throwing here
    // would 500 the reporting endpoint for a report already persisted, and leave
    // no queue item for it: the steward never sees the post-resolution report.
    const retried = await this.#db
      .insert(aiReviewQueue)
      .values({
        reviewId: `airev-${randomUUID()}`,
        kind: item.kind,
        subjectRef: item.subjectRef,
        context: item.context,
        status: item.status,
        resolution: item.resolution,
        resolvedBy: item.resolvedBy,
        createdAt: new Date(),
        resolvedAt: null,
      })
      .onConflictDoNothing()
      .returning();
    const retriedRow = retried[0];
    if (retriedRow) return this.#toItem(retriedRow);
    // A THIRD party opened a pending item in the meantime — that is the
    // dedup working, so return theirs rather than failing.
    const raced = await this.#db
      .select()
      .from(aiReviewQueue)
      .where(
        and(
          eq(aiReviewQueue.kind, item.kind),
          eq(aiReviewQueue.subjectRef, item.subjectRef),
          eq(aiReviewQueue.status, 'pending'),
        ),
      )
      .limit(1);
    const racedRow = raced[0];
    if (!racedRow) throw new Error('ai_review_queue insert returned no row');
    return this.#toItem(racedRow);
  }

  async get(reviewId: string): Promise<AiReviewItem | null> {
    const rows = await this.#db
      .select()
      .from(aiReviewQueue)
      .where(eq(aiReviewQueue.reviewId, reviewId))
      .limit(1);
    return rows[0] ? this.#toItem(rows[0]) : null;
  }

  async list(
    filter: { status?: AiReviewItem['status']; kind?: AiReviewKind },
    limit: number,
  ): Promise<AiReviewItem[]> {
    const conditions = [];
    if (filter.status !== undefined) conditions.push(eq(aiReviewQueue.status, filter.status));
    if (filter.kind !== undefined) conditions.push(eq(aiReviewQueue.kind, filter.kind));
    const rows = await this.#db
      .select()
      .from(aiReviewQueue)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(asc(aiReviewQueue.createdAt), asc(aiReviewQueue.reviewId))
      .limit(limit);
    return rows.map((row) => this.#toItem(row));
  }

  async resolve(
    reviewId: string,
    resolution: string,
    resolvedBy: string,
    atIso: string,
  ): Promise<AiReviewItem | null> {
    const rows = await this.#db
      .update(aiReviewQueue)
      .set({ status: 'resolved', resolution, resolvedBy, resolvedAt: new Date(atIso) })
      .where(eq(aiReviewQueue.reviewId, reviewId))
      .returning();
    return rows[0] ? this.#toItem(rows[0]) : null;
  }

  async clear(): Promise<void> {
    await this.#db.delete(aiReviewQueue);
  }
}

// --- WS-K.1.4 summary drafts + reports ---------------------------------------

export class DrizzleSummaryStore implements SummaryStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  async putDraft(record: SummaryDraftRecord): Promise<void> {
    await this.#db
      .insert(aiSummaryDrafts)
      .values({
        summaryId: record.summaryId,
        threadId: record.threadId,
        draft: record.draft,
        outputId: record.outputId,
        qualityPassed: record.qualityPassed,
        createdAt: new Date(record.createdAt),
      })
      .onConflictDoUpdate({
        target: aiSummaryDrafts.summaryId,
        set: {
          threadId: record.threadId,
          draft: record.draft,
          outputId: record.outputId,
          qualityPassed: record.qualityPassed,
          createdAt: new Date(record.createdAt),
        },
      });
  }

  async getDraft(summaryId: string): Promise<SummaryDraftRecord | null> {
    const rows = await this.#db
      .select()
      .from(aiSummaryDrafts)
      .where(eq(aiSummaryDrafts.summaryId, summaryId))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      summaryId: row.summaryId,
      threadId: row.threadId,
      draft: row.draft,
      outputId: row.outputId,
      qualityPassed: row.qualityPassed,
      createdAt: iso(row.createdAt),
    };
  }

  async getLatestForThread(threadId: string): Promise<SummaryDraftRecord | null> {
    const rows = await this.#db
      .select()
      .from(aiSummaryDrafts)
      .where(eq(aiSummaryDrafts.threadId, threadId))
      // `created_at DESC, summary_id DESC` is a TOTAL order: two drafts written
      // in the same clock tick must still yield one deterministic answer, or
      // the sweep's "is this thread due" question could flip between ticks.
      .orderBy(desc(aiSummaryDrafts.createdAt), desc(aiSummaryDrafts.summaryId))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      summaryId: row.summaryId,
      threadId: row.threadId,
      draft: row.draft,
      outputId: row.outputId,
      qualityPassed: row.qualityPassed,
      createdAt: iso(row.createdAt),
    };
  }

  async putReport(report: SummaryReport): Promise<void> {
    await this.#db.insert(aiSummaryReports).values({
      reportId: report.report_id,
      summaryId: report.summary_id,
      reason: report.reason,
      correctionText: report.correction_text,
      createdAt: new Date(report.reported_at),
    });
  }

  async listReports(summaryId: string): Promise<SummaryReport[]> {
    const rows = await this.#db
      .select()
      .from(aiSummaryReports)
      .where(eq(aiSummaryReports.summaryId, summaryId))
      .orderBy(asc(aiSummaryReports.createdAt), asc(aiSummaryReports.reportId));
    return rows.map((row) => ({
      report_id: row.reportId,
      summary_id: row.summaryId,
      reason: row.reason as SummaryReport['reason'],
      correction_text: row.correctionText ?? null,
      reported_at: iso(row.createdAt),
    }));
  }

  async countReportsByReason(): Promise<Record<string, number>> {
    const rows = await this.#db
      .select({ reason: aiSummaryReports.reason, count: sql<number>`count(*)::int` })
      .from(aiSummaryReports)
      .groupBy(aiSummaryReports.reason);
    return Object.fromEntries(rows.map((row) => [row.reason, row.count]));
  }

  async clear(): Promise<void> {
    await this.#db.delete(aiSummaryDrafts);
    await this.#db.delete(aiSummaryReports);
  }
}

// --- WS-K.2.1a translations + reports ----------------------------------------

export class DrizzleTranslationStore implements TranslationStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  #toTranslation(row: typeof aiTranslations.$inferSelect): AiTranslation {
    return {
      translation_id: row.translationId,
      source_kind: row.sourceKind as AiTranslation['source_kind'],
      source_ref: row.sourceRef,
      source_lang: row.sourceLang,
      target_lang: row.targetLang,
      translated_text: row.translatedText,
      label: 'AI-translated',
      consistency_passed: row.consistencyPassed,
      model_name: row.modelName,
      model_version: row.modelVersion,
      output_id: row.outputId,
      translated_at: iso(row.createdAt),
    };
  }

  async put(translation: AiTranslation): Promise<void> {
    const values = {
      sourceKind: translation.source_kind,
      sourceRef: translation.source_ref,
      sourceLang: translation.source_lang,
      targetLang: translation.target_lang,
      translatedText: translation.translated_text,
      consistencyPassed: translation.consistency_passed,
      outputId: translation.output_id,
      modelName: translation.model_name,
      modelVersion: translation.model_version,
      createdAt: new Date(translation.translated_at),
    };
    await this.#db
      .insert(aiTranslations)
      .values({ translationId: translation.translation_id, ...values })
      .onConflictDoUpdate({ target: aiTranslations.translationId, set: values });
  }

  async get(translationId: string): Promise<AiTranslation | null> {
    const rows = await this.#db
      .select()
      .from(aiTranslations)
      .where(eq(aiTranslations.translationId, translationId))
      .limit(1);
    return rows[0] ? this.#toTranslation(rows[0]) : null;
  }

  async findBySource(sourceRef: string, targetLang: string): Promise<AiTranslation | null> {
    const rows = await this.#db
      .select()
      .from(aiTranslations)
      .where(
        and(eq(aiTranslations.sourceRef, sourceRef), eq(aiTranslations.targetLang, targetLang)),
      )
      .orderBy(asc(aiTranslations.createdAt))
      .limit(1);
    return rows[0] ? this.#toTranslation(rows[0]) : null;
  }

  async putReport(report: TranslationReport): Promise<void> {
    await this.#db.insert(aiTranslationReports).values({
      reportId: report.report_id,
      translationId: report.translation_id,
      reason: report.reason,
      createdAt: new Date(report.reported_at),
    });
  }

  async listReports(translationId: string): Promise<TranslationReport[]> {
    const rows = await this.#db
      .select()
      .from(aiTranslationReports)
      .where(eq(aiTranslationReports.translationId, translationId))
      .orderBy(asc(aiTranslationReports.createdAt), asc(aiTranslationReports.reportId));
    return rows.map((row) => ({
      report_id: row.reportId,
      translation_id: row.translationId,
      reason: row.reason as TranslationReport['reason'],
      reported_at: iso(row.createdAt),
    }));
  }

  async clear(): Promise<void> {
    await this.#db.delete(aiTranslations);
    await this.#db.delete(aiTranslationReports);
  }
}

// --- WS-K.2.2a governance proposal summaries ---------------------------------

export class DrizzleGovernanceSummaryStore implements GovernanceSummaryStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  async put(summary: GovernanceProposalSummary): Promise<void> {
    await this.#db
      .insert(aiGovernanceSummaries)
      .values({
        summaryId: summary.summary_id,
        proposalRef: summary.proposal_ref,
        summary: asJson(summary),
        outputId: summary.output_id,
        stewardEdited: summary.steward_edited,
        createdAt: new Date(summary.generated_at),
      })
      .onConflictDoUpdate({
        target: aiGovernanceSummaries.summaryId,
        set: {
          proposalRef: summary.proposal_ref,
          summary: asJson(summary),
          outputId: summary.output_id,
          stewardEdited: summary.steward_edited,
        },
      });
  }

  async get(summaryId: string): Promise<GovernanceProposalSummary | null> {
    const rows = await this.#db
      .select()
      .from(aiGovernanceSummaries)
      .where(eq(aiGovernanceSummaries.summaryId, summaryId))
      .limit(1);
    return rows[0] ? (rows[0].summary as GovernanceProposalSummary) : null;
  }

  async listByProposal(proposalRef: string): Promise<GovernanceProposalSummary[]> {
    const rows = await this.#db
      .select()
      .from(aiGovernanceSummaries)
      .where(eq(aiGovernanceSummaries.proposalRef, proposalRef))
      .orderBy(asc(aiGovernanceSummaries.createdAt), asc(aiGovernanceSummaries.summaryId));
    return rows.map((row) => row.summary as GovernanceProposalSummary);
  }

  async clear(): Promise<void> {
    await this.#db.delete(aiGovernanceSummaries);
  }
}

export class DrizzleSweepCursorStore implements SweepCursorStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  async get(sweepName: string): Promise<SweepCursor | null> {
    const rows = await this.#db
      .select()
      .from(aiSweepCursors)
      .where(eq(aiSweepCursors.sweepName, sweepName))
      .limit(1);
    const row = rows[0];
    if (!row || row.cursorCreatedAt === null || row.cursorRef === null) return null;
    return { createdAt: iso(row.cursorCreatedAt), ref: row.cursorRef };
  }

  async set(sweepName: string, cursor: SweepCursor | null): Promise<void> {
    // UPSERT rather than delete-on-null: the row records that this sweep has a
    // position at all, and a null pair is the honest spelling of "back at the
    // newest page" — deleting it would make "never run" and "wrapped" the same
    // state.
    const values = {
      cursorCreatedAt: cursor === null ? null : new Date(cursor.createdAt),
      cursorRef: cursor?.ref ?? null,
      updatedAt: new Date(),
    };
    await this.#db
      .insert(aiSweepCursors)
      .values({ sweepName, ...values })
      .onConflictDoUpdate({ target: aiSweepCursors.sweepName, set: values });
  }

  async clear(): Promise<void> {
    await this.#db.delete(aiSweepCursors);
  }
}

export class DrizzleGovernanceAdvisoryStore implements GovernanceAdvisoryStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  async put(advisory: GovernanceAdvisory): Promise<void> {
    await this.#db
      .insert(aiGovernanceAdvisories)
      .values({
        advisoryId: advisory.advisory_id,
        proposalRef: advisory.proposal_ref,
        kind: advisory.kind,
        advisory: asJson(advisory),
        outputId: advisory.output_id,
        createdAt: new Date(advisory.generated_at),
      })
      .onConflictDoNothing();
  }

  async listByProposal(proposalRef: string): Promise<GovernanceAdvisory[]> {
    const rows = await this.#db
      .select()
      .from(aiGovernanceAdvisories)
      .where(eq(aiGovernanceAdvisories.proposalRef, proposalRef))
      .orderBy(asc(aiGovernanceAdvisories.createdAt), asc(aiGovernanceAdvisories.advisoryId));
    return rows.map((row) => row.advisory as GovernanceAdvisory);
  }

  async clear(): Promise<void> {
    await this.#db.delete(aiGovernanceAdvisories);
  }
}

// --- WS-K.1.2f runtime monitoring --------------------------------------------

export class DrizzleRuntimeMonitorStore implements RuntimeMonitorStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  async recordMetric(point: RuntimeMetricPoint): Promise<void> {
    await this.#db.insert(aiRuntimeMetrics).values({
      modelName: point.modelName,
      modelVersion: point.modelVersion,
      metric: point.metric,
      value: point.value,
      recordedAt: new Date(point.recordedAt),
    });
  }

  async listMetrics(
    modelName: string,
    metric: string,
    sinceIso: string,
  ): Promise<RuntimeMetricPoint[]> {
    const rows = await this.#db
      .select()
      .from(aiRuntimeMetrics)
      .where(
        and(
          eq(aiRuntimeMetrics.modelName, modelName),
          eq(aiRuntimeMetrics.metric, metric),
          gte(aiRuntimeMetrics.recordedAt, new Date(sinceIso)),
        ),
      )
      .orderBy(asc(aiRuntimeMetrics.recordedAt));
    return rows.map((row) => ({
      modelName: row.modelName,
      modelVersion: row.modelVersion,
      metric: row.metric,
      value: row.value,
      recordedAt: iso(row.recordedAt),
    }));
  }

  async recordAlert(alert: RuntimeAlertRecord): Promise<void> {
    await this.#db.insert(aiRuntimeAlerts).values({
      modelName: alert.modelName,
      modelVersion: alert.modelVersion,
      metric: alert.metric,
      value: alert.value,
      threshold: alert.threshold,
      rollbackRecommendation: alert.rollbackRecommendation,
      raisedAt: new Date(alert.raisedAt),
    });
  }

  async listAlerts(limit: number): Promise<RuntimeAlertRecord[]> {
    const rows = await this.#db
      .select()
      .from(aiRuntimeAlerts)
      .orderBy(desc(aiRuntimeAlerts.raisedAt))
      .limit(limit);
    return rows.map((row) => ({
      modelName: row.modelName,
      modelVersion: row.modelVersion,
      metric: row.metric,
      value: row.value,
      threshold: row.threshold,
      rollbackRecommendation: row.rollbackRecommendation ?? null,
      raisedAt: iso(row.raisedAt),
    }));
  }

  async clear(): Promise<void> {
    await this.#db.delete(aiRuntimeMetrics);
    await this.#db.delete(aiRuntimeAlerts);
  }
}

// --- WS-U in-room moderation decision log (ADR-9) ----------------------------

export class DrizzleModerationDecisionLog implements ModerationDecisionLogStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  async append(record: ModerationDecisionRecord): Promise<void> {
    await this.#db.insert(aiModerationDecisions).values({
      recordId: record.recordId,
      roomId: record.roomId,
      subjectRef: record.subjectRef,
      proposedAction: record.proposedAction,
      boundedAction: record.boundedAction,
      clamped: record.clamped,
      outputId: record.outputId,
      createdAt: new Date(record.createdAt),
    });
  }

  async listByRoom(roomId: string, limit: number): Promise<ModerationDecisionRecord[]> {
    const rows = await this.#db
      .select()
      .from(aiModerationDecisions)
      .where(eq(aiModerationDecisions.roomId, roomId))
      .orderBy(desc(aiModerationDecisions.createdAt), desc(aiModerationDecisions.recordId))
      .limit(limit);
    return rows.map((row) => ({
      recordId: row.recordId,
      roomId: row.roomId,
      subjectRef: row.subjectRef,
      proposedAction: row.proposedAction,
      boundedAction: row.boundedAction,
      clamped: row.clamped,
      outputId: row.outputId ?? null,
      createdAt: iso(row.createdAt),
    }));
  }

  async summaryByRoom(roomId: string): Promise<ModerationDecisionSummary> {
    const rows = await this.#db
      .select({
        total: sql<number>`count(*)::int`,
        allowed: sql<number>`count(*) filter (where ${aiModerationDecisions.boundedAction} = 'allow')::int`,
        warned: sql<number>`count(*) filter (where ${aiModerationDecisions.boundedAction} = 'warn')::int`,
        flaggedForReview: sql<number>`count(*) filter (where ${aiModerationDecisions.boundedAction} = 'flag_for_review')::int`,
        clampedByWrapper: sql<number>`count(*) filter (where ${aiModerationDecisions.clamped})::int`,
      })
      .from(aiModerationDecisions)
      .where(eq(aiModerationDecisions.roomId, roomId));
    const row = rows[0];
    return {
      total: row?.total ?? 0,
      allowed: row?.allowed ?? 0,
      warned: row?.warned ?? 0,
      flaggedForReview: row?.flaggedForReview ?? 0,
      clampedByWrapper: row?.clampedByWrapper ?? 0,
    };
  }

  async clear(): Promise<void> {
    await this.#db.delete(aiModerationDecisions);
  }
}

// --- The boot-wiring factory --------------------------------------------------

export interface DrizzleAiGovernanceStores {
  registry: ModelRegistryStore;
  riskAssessments: RiskAssessmentStore;
  inventory: InventoryStore;
  lineage: DataLineageStore;
  outputRecords: AiOutputRecordStore;
  evaluations: EvaluationStore;
  corrections: CorrectionStore;
  blocked: BlockedInvocationStore;
  reviewQueue: AiReviewQueueStore;
  summaries: SummaryStore;
  translations: TranslationStore;
  governanceAdvisories: GovernanceAdvisoryStore;
  sweepCursors: SweepCursorStore;
  governanceSummaries: GovernanceSummaryStore;
  runtime: RuntimeMonitorStore;
  moderationLog: ModerationDecisionLogStore;
}

/** All fourteen WS-K Drizzle adapters, ready for the boot swap.  NOTE for the
 *  wiring site: the ProhibitedUseGuard captures the blocked-invocation store at
 *  construction, so the guard must be REBUILT over `blocked` after the swap —
 *  otherwise its audit rows keep flowing to the in-memory store. */
export function createDrizzleAiGovernanceStores(db: Db): DrizzleAiGovernanceStores {
  return {
    registry: new DrizzleModelRegistryStore(db),
    riskAssessments: new DrizzleRiskAssessmentStore(db),
    inventory: new DrizzleInventoryStore(db),
    lineage: new DrizzleDataLineageStore(db),
    outputRecords: new DrizzleAiOutputRecordStore(db),
    evaluations: new DrizzleEvaluationStore(db),
    corrections: new DrizzleCorrectionStore(db),
    blocked: new DrizzleBlockedInvocationStore(db),
    reviewQueue: new DrizzleAiReviewQueueStore(db),
    summaries: new DrizzleSummaryStore(db),
    translations: new DrizzleTranslationStore(db),
    governanceAdvisories: new DrizzleGovernanceAdvisoryStore(db),
    sweepCursors: new DrizzleSweepCursorStore(db),
    governanceSummaries: new DrizzleGovernanceSummaryStore(db),
    runtime: new DrizzleRuntimeMonitorStore(db),
    moderationLog: new DrizzleModerationDecisionLog(db),
  };
}
