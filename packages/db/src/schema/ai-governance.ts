// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-K AI & Model Governance tables (SPEC §24). The persistent substrate behind
// the model registry/deployment gate, the AI inventory + risk assessments,
// immutable data lineage, audit-sensitive output records, the evaluation
// harness, human-in-the-loop corrections, the pre-execution prohibited-use
// audit, AI summaries/translations + their reports, and runtime monitoring.
//
// Immutability is structural where the doctrine requires it: `ai_data_lineage`
// and `ai_output_records` are append-only by convention (no UPDATE path in the
// adapters), and the model card's `update_history` is append-only at the
// application boundary (WS-K.1.1b). Status transitions on `ai_model_cards`
// (registered → deployed → deprecated) are the one mutable column on that table.
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/** The model registry: one row per (name, version); versions are preserved. */
export const aiModelCards = pgTable(
  'ai_model_cards',
  {
    name: text('name').notNull(),
    version: text('version').notNull(),
    /** The full ModelCard (WS-K.1.1a); update_history is append-only. */
    card: jsonb('card').$type<Record<string, unknown>>().notNull(),
    status: text('status').notNull().default('registered'),
    /** Deprecation metadata (present iff status = deprecated). */
    deprecation: jsonb('deprecation').$type<Record<string, unknown>>(),
    registeredAt: timestamp('registered_at', { withTimezone: true }).notNull().defaultNow(),
    deployedAt: timestamp('deployed_at', { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.name, t.version] }),
    index('ai_model_cards_name_idx').on(t.name),
    index('ai_model_cards_status_idx').on(t.status),
    check('ai_model_cards_status', sql`${t.status} in ('registered', 'deployed', 'deprecated')`),
    // One deployed version per model name, enforced STRUCTURALLY: two
    // concurrent deploys (multi-replica admin route) cannot both commit —
    // the second promote fails the partial unique index instead of silently
    // leaving two `deployed` rows.
    uniqueIndex('ai_model_cards_one_deployed_idx').on(t.name).where(sql`${t.status} = 'deployed'`),
  ],
);

/** NIST/ISO risk assessments (WS-K.1.1c), referenceable by model cards. */
export const aiRiskAssessments = pgTable('ai_risk_assessments', {
  assessmentId: text('assessment_id').primaryKey(),
  useCaseId: text('use_case_id').notNull(),
  assessment: jsonb('assessment').$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Version-controlled AI inventory snapshots (WS-K.1.1c) — append-only. */
export const aiInventoryVersions = pgTable('ai_inventory_versions', {
  version: integer('version').primaryKey(),
  inventory: jsonb('inventory').$type<Record<string, unknown>>().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Immutable, append-only data lineage (WS-K.1.1e). */
export const aiDataLineage = pgTable(
  'ai_data_lineage',
  {
    datasetId: text('dataset_id').notNull(),
    version: text('version').notNull(),
    record: jsonb('record').$type<Record<string, unknown>>().notNull(),
    containsUserDerived: boolean('contains_user_derived').notNull(),
    usable: boolean('usable').notNull(),
    privacyReviewRef: text('privacy_review_ref'),
    predecessorDatasetId: text('predecessor_dataset_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.datasetId, t.version] }),
    index('ai_data_lineage_usable_idx').on(t.usable),
    // A usable user-derived dataset MUST carry a privacy review (§24.2).
    check(
      'ai_data_lineage_privacy_review',
      sql`(not ${t.usable}) or (not ${t.containsUserDerived}) or (${t.privacyReviewRef} is not null)`,
    ),
  ],
);

/** Immutable audit-sensitive AI output records (WS-K.1.1f) — append-only. */
export const aiOutputRecords = pgTable(
  'ai_output_records',
  {
    outputId: text('output_id').primaryKey(),
    modelName: text('model_name').notNull(),
    modelVersion: text('model_version').notNull(),
    promptTemplateId: text('prompt_template_id').notNull(),
    configHash: text('config_hash').notNull(),
    inputRefs: jsonb('input_refs').$type<string[]>().notNull(),
    outputRef: text('output_ref').notNull(),
    useCaseId: text('use_case_id').notNull(),
    /** Set once a downstream human correction exists (WS-K.1.3c/1.4c). */
    correctionRef: text('correction_ref'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    index('ai_output_records_model_idx').on(t.modelName, t.modelVersion),
    index('ai_output_records_use_case_idx').on(t.useCaseId, t.createdAt),
    index('ai_output_records_created_idx').on(t.createdAt),
    check('ai_output_records_config_hash', sql`${t.configHash} ~ '^[0-9a-f]{64}$'`),
  ],
);

/** Harness evaluation decisions (WS-K.1.2e), the deploy-gate record of truth. */
export const aiEvaluations = pgTable(
  'ai_evaluations',
  {
    evaluationId: uuid('evaluation_id').primaryKey().defaultRandom(),
    modelName: text('model_name').notNull(),
    modelVersion: text('model_version').notNull(),
    decision: text('decision').notNull(),
    decisionData: jsonb('decision_data').$type<Record<string, unknown>>().notNull(),
    evaluatedAt: timestamp('evaluated_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    index('ai_evaluations_model_idx').on(t.modelName, t.modelVersion, t.evaluatedAt),
    check('ai_evaluations_decision', sql`${t.decision} in ('deploy', 'block')`),
  ],
);

/** Human-in-the-loop corrections (WS-K.1.3c). */
export const aiCorrections = pgTable(
  'ai_corrections',
  {
    correctionId: text('correction_id').primaryKey(),
    outputId: text('output_id').notNull(),
    useCaseId: text('use_case_id').notNull(),
    action: text('action').notNull(),
    originalValue: text('original_value').notNull(),
    correctedValue: text('corrected_value'),
    /** `steward:<id>` — never a raw identity. */
    stewardRef: text('steward_ref').notNull(),
    category: text('category'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    index('ai_corrections_use_case_idx').on(t.useCaseId, t.createdAt),
    index('ai_corrections_output_idx').on(t.outputId),
    check('ai_corrections_action', sql`${t.action} in ('confirm', 'reject', 'modify')`),
    check(
      'ai_corrections_modify_value',
      sql`(${t.action} = 'modify') = (${t.correctedValue} is not null)`,
    ),
  ],
);

/** Pre-execution prohibited-use blocks (WS-K.1.1d audit) — append-only. */
export const aiBlockedInvocations = pgTable(
  'ai_blocked_invocations',
  {
    blockId: text('block_id').primaryKey(),
    prohibition: text('prohibition').notNull(),
    useCaseId: text('use_case_id').notNull(),
    capability: text('capability').notNull(),
    caller: text('caller').notNull(),
    contextRef: text('context_ref'),
    reason: text('reason').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    index('ai_blocked_invocations_prohibition_idx').on(t.prohibition, t.createdAt),
    index('ai_blocked_invocations_created_idx').on(t.createdAt),
  ],
);

/** Structured AI summary drafts backing a WS-G summary (WS-K.1.4a). */
export const aiSummaryDrafts = pgTable(
  'ai_summary_drafts',
  {
    /** The WS-G summary id this draft backs. */
    summaryId: text('summary_id').primaryKey(),
    threadId: text('thread_id').notNull(),
    draft: jsonb('draft').$type<Record<string, unknown>>().notNull(),
    outputId: text('output_id').notNull(),
    qualityPassed: boolean('quality_passed').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('ai_summary_drafts_thread_idx').on(t.threadId)],
);

/** User reports of AI summaries (WS-K.1.4c). Reporter identity is never stored
 *  alongside the report body shown to stewards. */
export const aiSummaryReports = pgTable(
  'ai_summary_reports',
  {
    reportId: text('report_id').primaryKey(),
    summaryId: text('summary_id').notNull(),
    reason: text('reason').notNull(),
    correctionText: text('correction_text'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('ai_summary_reports_summary_idx').on(t.summaryId, t.createdAt)],
);

/** AI translations (WS-K.2.1a); the original (source_ref) is always canonical. */
export const aiTranslations = pgTable(
  'ai_translations',
  {
    translationId: text('translation_id').primaryKey(),
    sourceKind: text('source_kind').notNull(),
    sourceRef: text('source_ref').notNull(),
    sourceLang: text('source_lang').notNull(),
    targetLang: text('target_lang').notNull(),
    translatedText: text('translated_text').notNull(),
    consistencyPassed: boolean('consistency_passed').notNull(),
    outputId: text('output_id').notNull(),
    modelName: text('model_name').notNull(),
    modelVersion: text('model_version').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    index('ai_translations_source_idx').on(t.sourceRef, t.targetLang),
    check('ai_translations_langs', sql`${t.sourceLang} <> ${t.targetLang}`),
  ],
);

/** User reports of AI translations (WS-K.2.1a). */
export const aiTranslationReports = pgTable(
  'ai_translation_reports',
  {
    reportId: text('report_id').primaryKey(),
    translationId: text('translation_id').notNull(),
    reason: text('reason').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('ai_translation_reports_translation_idx').on(t.translationId)],
);

/** Governance proposal summaries (WS-K.2.2a) — advisory, never autonomous. */
export const aiGovernanceSummaries = pgTable(
  'ai_governance_summaries',
  {
    summaryId: text('summary_id').primaryKey(),
    proposalRef: text('proposal_ref').notNull(),
    summary: jsonb('summary').$type<Record<string, unknown>>().notNull(),
    outputId: text('output_id').notNull(),
    stewardEdited: boolean('steward_edited').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('ai_governance_summaries_proposal_idx').on(t.proposalRef)],
);

/** Runtime AI monitoring metric time series (WS-K.1.2f). */
export const aiRuntimeMetrics = pgTable(
  'ai_runtime_metrics',
  {
    metricId: uuid('metric_id').primaryKey().defaultRandom(),
    modelName: text('model_name').notNull(),
    modelVersion: text('model_version').notNull(),
    metric: text('metric').notNull(),
    value: doublePrecision('value').notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    index('ai_runtime_metrics_model_idx').on(t.modelName, t.modelVersion, t.metric, t.recordedAt),
  ],
);

/** Runtime AI monitoring alerts (WS-K.1.2f); rollback is human-approved. */
export const aiRuntimeAlerts = pgTable(
  'ai_runtime_alerts',
  {
    alertId: uuid('alert_id').primaryKey().defaultRandom(),
    modelName: text('model_name').notNull(),
    modelVersion: text('model_version').notNull(),
    metric: text('metric').notNull(),
    value: doublePrecision('value').notNull(),
    threshold: doublePrecision('threshold').notNull(),
    /** A recommended (never auto-executed) rollback target version. */
    rollbackRecommendation: text('rollback_recommendation'),
    raisedAt: timestamp('raised_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('ai_runtime_alerts_model_idx').on(t.modelName, t.modelVersion, t.raisedAt)],
);

/** The WS-K human-review queue: low-confidence classifications, reported
 *  summaries/translations, and flagged hallucinations awaiting a steward. */
export const aiReviewQueue = pgTable(
  'ai_review_queue',
  {
    reviewId: text('review_id').primaryKey(),
    kind: text('kind').notNull(),
    /** The subject (story id, summary id, translation id, output id). */
    subjectRef: text('subject_ref').notNull(),
    context: jsonb('context').$type<Record<string, unknown>>().notNull(),
    status: text('status').notNull().default('pending'),
    resolution: text('resolution'),
    resolvedBy: text('resolved_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (t) => [
    index('ai_review_queue_status_idx').on(t.status, t.createdAt),
    index('ai_review_queue_kind_idx').on(t.kind, t.createdAt),
    check('ai_review_queue_status', sql`${t.status} in ('pending', 'resolved')`),
    check(
      'ai_review_queue_kind',
      sql`${t.kind} in ('low_confidence_classification', 'reported_summary', 'reported_translation', 'flagged_hallucination')`,
    ),
    check(
      'ai_review_queue_resolved',
      sql`(${t.status} = 'resolved') = (${t.resolvedAt} is not null)`,
    ),
  ],
);

/** The WS-U in-room moderation decision log (ADR-9): what the model PROPOSED
 *  vs what the deterministic wrapper PERMITTED — the transparency of bounded
 *  autonomy.  Append-only; metadata only (no content text, no attention
 *  values, no user identity beyond the contribution ref the agent-action
 *  audit log already carries). */
export const aiModerationDecisions = pgTable(
  'ai_moderation_decisions',
  {
    recordId: text('record_id').primaryKey(),
    roomId: text('room_id').notNull(),
    /** The moderated contribution id (matches the agent-action audit log). */
    subjectRef: text('subject_ref').notNull(),
    proposedAction: text('proposed_action').notNull(),
    boundedAction: text('bounded_action').notNull(),
    /** True when the ceiling and/or capability clamp reduced the proposal. */
    clamped: boolean('clamped').notNull(),
    /** The AIOutputRecord id of the invocation (provenance); null if none. */
    outputId: text('output_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('ai_moderation_decisions_room_idx').on(t.roomId, t.createdAt)],
);

export type AiModelCardRow = typeof aiModelCards.$inferSelect;
export type AiRiskAssessmentRow = typeof aiRiskAssessments.$inferSelect;
export type AiInventoryVersionRow = typeof aiInventoryVersions.$inferSelect;
export type AiDataLineageRow = typeof aiDataLineage.$inferSelect;
export type AiOutputRecordRow = typeof aiOutputRecords.$inferSelect;
export type AiEvaluationRow = typeof aiEvaluations.$inferSelect;
export type AiCorrectionRow = typeof aiCorrections.$inferSelect;
export type AiBlockedInvocationRow = typeof aiBlockedInvocations.$inferSelect;
export type AiSummaryDraftRow = typeof aiSummaryDrafts.$inferSelect;
export type AiSummaryReportRow = typeof aiSummaryReports.$inferSelect;
export type AiTranslationRow = typeof aiTranslations.$inferSelect;
export type AiTranslationReportRow = typeof aiTranslationReports.$inferSelect;
export type AiGovernanceSummaryRow = typeof aiGovernanceSummaries.$inferSelect;
export type AiRuntimeMetricRow = typeof aiRuntimeMetrics.$inferSelect;
export type AiRuntimeAlertRow = typeof aiRuntimeAlerts.$inferSelect;
export type AiReviewQueueRow = typeof aiReviewQueue.$inferSelect;
export type AiModerationDecisionRow = typeof aiModerationDecisions.$inferSelect;
