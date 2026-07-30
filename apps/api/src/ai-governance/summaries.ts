// SPDX-License-Identifier: AGPL-3.0-or-later
//
// AI summary pipeline (WS-K.1.4a/b/c, SPEC §15.4/§24.3). Generates the never-final
// automated draft from a thread's root contributions as a STRUCTURED draft
// (facts/claims/interpretations, explicit unresolved questions and minority
// views), runs the §24.3 quality constraints AND the source-grounding/attribution
// checks, and ONLY publishes (as the WS-G automated_draft layer, machine-generated
// label) when both pass — otherwise the draft is withheld and routed to steward
// review. Every summary writes an AIOutputRecord; users can report a published
// summary (routes to review + the model-improvement loop).

import { randomUUID } from 'node:crypto';
import {
  type AiSummaryDraft,
  aiSummaryDraftSchema,
  checkSummaryQuality,
  detectHallucination,
  type GroundingStatement,
  type SummaryReport,
  type SummaryReportReason,
  sentenceSplit,
  summaryReportSchema,
  type ThreadQualitySignals,
} from '@licio/ai-governance';
import type { ContributionRecord, ContributionStore } from '../forum/stores.js';
import type { StoryStore } from '../ingestion/stores.js';
import type { ProhibitedUseGuard } from './guard.js';
import type { AiGovernanceMetrics } from './metrics.js';
import { THREAD_SUMMARIZER } from './models.js';
import { recordAiOutput } from './output-records.js';
import type { AiOutputRecordStore, AiReviewQueueStore, SummaryStore } from './stores.js';

/** Default harassment/slur markers (non-graphic; production injects the WS-A
 *  policy denylist). The check fails a summary that reproduces any of these. */
export const DEFAULT_SLUR_DENYLIST: readonly string[] = ['idiot', 'moron', 'scum', 'vermin'];

const ROOT_CAP = 12;

export interface SummaryPipelineDeps {
  contributions: ContributionStore;
  stories: StoryStore;
  aiSummaries: SummaryStore;
  outputRecords: AiOutputRecordStore;
  reviewQueue: AiReviewQueueStore;
  guard: ProhibitedUseGuard;
  slurDenylist?: () => readonly string[];
  minActivity: () => number;
  metrics: AiGovernanceMetrics;
  log: (event: string, meta: Record<string, unknown>) => void;
  now: () => number;
}

/**
 * The schema's text bound, in ONE place.
 *
 * `aiSummaryDraftSchema` caps every text field at 2,000 while
 * `CONTRIBUTION_BODY_LIMITS` allows 5,000, so anything copied out of a comment has
 * to be clamped — and `unresolved_questions` was not.  A single 3,000-character
 * question sentence therefore made `parse` throw for that thread on every tick,
 * from ordinary legal content rather than an attack: the statements path clamped
 * and the questions path did not, two spellings of one obligation with only one
 * applied.
 */
const CLAMP = 2_000;
function clampText(text: string): string {
  return text.slice(0, CLAMP).trim();
}

/**
 * The thread's open questions — ONE extraction, for both consumers.
 *
 * `signalsFor` used to decide `hasOpenQuestions` from `/\?/` over the raw body
 * while this list requires a sentence-FINAL `?`, so the two disagreed on any
 * thread whose only `?` sits inside a URL (`…/a?b=1`) or mid-sentence: the
 * signal said questions exist, the list came back empty, and constraint 2
 * ("open questions not listed") withheld the summary for ever.  Deriving the
 * signal from the list itself is what makes the two answers unable to differ.
 */
function extractQuestions(roots: readonly ContributionRecord[]): string[] {
  return (
    roots
      .flatMap((r) => sentenceSplit(r.body))
      .filter((s) => s.endsWith('?'))
      // Clamped like every other text here, and empties dropped — the schema's
      // `.min(1)` refuses a string that trims to nothing just as firmly as an
      // over-long one.
      .map(clampText)
      .filter((s) => s.length > 0)
      .slice(0, 5)
  );
}

function firstSentence(body: string): string {
  const sentence = sentenceSplit(body)[0] ?? body.trim();
  return clampText(sentence) || '(no content)';
}

/** Build a structured draft from the thread's root contributions. */
function buildDraft(
  threadId: string,
  roots: readonly ContributionRecord[],
  outputId: string,
  nowIso: string,
): AiSummaryDraft {
  const statements = roots.map((root) => {
    // Sourced comments (≥1 citation) read as fact statements; unsourced ones
    // stay attributed claims (comment-centric sourcing, WS-T).
    const isFact = root.citations.length > 0;
    return {
      kind: isFact ? ('fact' as const) : ('claim' as const),
      text: firstSentence(root.body),
      attribution: isFact ? null : 'A participant',
      cited_contribution_ids: [root.contributionId],
    };
  });
  const unresolved = extractQuestions(roots);
  const minorityRoot = roots.length >= 3 ? roots[roots.length - 1] : undefined;
  const minority = minorityRoot
    ? [
        {
          text: firstSentence(minorityRoot.body),
          cited_contribution_ids: [minorityRoot.contributionId],
        },
      ]
    : [];
  return aiSummaryDraftSchema.parse({
    thread_id: threadId,
    statements,
    unresolved_questions: unresolved,
    minority_views: minority,
    covered_contribution_ids: roots.map((r) => r.contributionId),
    model_name: THREAD_SUMMARIZER.name,
    model_version: THREAD_SUMMARIZER.version,
    output_id: outputId,
    generated_at: nowIso,
  } satisfies AiSummaryDraft);
}

/** Thread-derived signals the quality check uses (independent of the draft). */
function signalsFor(roots: readonly ContributionRecord[]): ThreadQualitySignals {
  const unsourcedRoots = roots.filter((r) => r.citations.length === 0).length;
  return {
    // The SAME extraction the draft's `unresolved_questions` comes from, so the
    // signal cannot claim a question the list does not carry.
    hasOpenQuestions: extractQuestions(roots).length > 0,
    hasMinorityView: roots.length >= 3,
    hasDisputedClaim: unsourcedRoots >= 2,
  };
}

export type SummaryOutcome =
  | { ok: true; published: boolean; summaryId: string }
  | { ok: false; reason: 'thread_not_found' | 'insufficient_activity' };

/** Generate (and conditionally publish) an automated draft summary. */
export async function generateThreadSummary(
  deps: SummaryPipelineDeps,
  threadId: string,
): Promise<SummaryOutcome> {
  const thread = await deps.stories.getThreadById(threadId);
  if (thread === null) return { ok: false, reason: 'thread_not_found' };
  const roots = await deps.contributions.listRoots(threadId, {
    states: ['published'],
    limit: ROOT_CAP,
    order: 'oldest',
  });
  if (roots.length < deps.minActivity()) return { ok: false, reason: 'insufficient_activity' };

  await deps.guard.enforce({
    use_case_id: 'summarization',
    capability: 'summarize_thread',
    caller: 'summary-pipeline',
    context_ref: threadId,
    effect: 'advisory',
    uses_wealth_signals: false,
    targets_risk_identity: false,
  });

  const nowIso = new Date(deps.now()).toISOString();
  const output = await recordAiOutput(deps.outputRecords, {
    modelName: THREAD_SUMMARIZER.name,
    modelVersion: THREAD_SUMMARIZER.version,
    promptTemplateId: THREAD_SUMMARIZER.promptTemplateId,
    config: THREAD_SUMMARIZER.config,
    inputRefs: roots.map((r) => r.contributionId),
    outputRef: threadId,
    useCaseId: 'summarization',
    nowIso,
  });
  const draft = buildDraft(threadId, roots, output.output_id, nowIso);

  // §24.3 quality constraints + source-grounding/attribution checks.
  const quality = checkSummaryQuality(draft, signalsFor(roots), {
    slurDenylist: deps.slurDenylist?.() ?? DEFAULT_SLUR_DENYLIST,
  });
  const groundingStatements: GroundingStatement[] = draft.statements.map((s) => {
    const cited = roots.find((r) => r.contributionId === s.cited_contribution_ids[0]);
    return {
      text: s.text,
      cited_ids: s.cited_contribution_ids,
      ...(cited ? { cited_source_texts: [cited.body] } : {}),
    };
  });
  const validCitationIds = new Set(roots.map((r) => r.contributionId));
  const grounding = detectHallucination(
    {
      statements: groundingStatements,
      source_text: roots.map((r) => r.body).join('\n'),
      valid_citation_ids: validCitationIds,
    },
    { rateThreshold: 0 },
  );

  // DERIVED FROM THE THREAD, not random.
  //
  // The withheld path writes the steward-review entry first (so a draft-write failure
  // cannot lose it), and the queue dedups pending items on `(kind, subjectRef)`.  With
  // a random id per attempt that dedup could never fire: a transient draft failure
  // made the retry mint a NEW subject, so each attempt left a pending review item
  // pointing at a draft that does not exist — up to three per tick from the in-tick
  // retries, and more on every later sweep, because `getLatestForThread` still finds
  // nothing.  A thread-derived id makes the retry reuse the same subject, so the
  // unique index collapses it and `putDraft` (an upsert on `summaryId`) overwrites
  // rather than accumulating.  One summary per thread is already the sweep's own
  // policy — `getLatestForThread` is what enforces it — so a stable id per thread
  // says the same thing the id was previously only pretending to be unique about.
  const summaryId = `sum-ai-${threadId}`;
  const passed = quality.passed && grounding.passed;
  const putDraft = (): Promise<void> =>
    deps.aiSummaries.putDraft({
      summaryId,
      threadId,
      draft: draft as unknown as Record<string, unknown>,
      outputId: output.output_id,
      qualityPassed: passed,
      createdAt: nowIso,
    });

  if (!passed) {
    // WITHHELD: the steward-review entry is written BEFORE the draft.
    //
    // The draft used to be written first, and the sweep's "already done" test is
    // `getLatestForThread` — so a failure on the queue insert left a draft with no
    // review entry, the next tick skipped the thread, and the entry that withholding
    // DEPENDS ON was lost permanently.  A summary withheld with nobody told is the
    // one outcome this branch must not produce.
    //
    // Reversing it means a failure on the DRAFT write leaves a pending queue entry
    // with no draft, and the retry mints a second one.  That is the better failure:
    // a duplicate steward item is visible and actionable, a missing one is neither.
    //
    // Withhold publication; route to steward review (never publish a summary
    // that fails the quality or grounding gate — §24.3).
    const evidence = {
      thread_id: threadId,
      quality_failures: quality.constraints.filter((c) => !c.passed).map((c) => c.constraint),
      hallucination_rate: grounding.hallucination_rate,
      output_id: output.output_id,
    };
    await deps.reviewQueue.insert({
      kind: 'flagged_hallucination',
      subjectRef: summaryId,
      context: evidence,
      status: 'pending',
      resolution: null,
      resolvedBy: null,
    });
    // THE ITEM FOLLOWS THE DRAFT.
    //
    // `summaryId` is stable per thread, so a retry after a failed draft write reuses
    // the subject and the queue's `(kind, subjectRef)` dedup returns the INCUMBENT —
    // deliberately, because for a repeat report that first context is an independent
    // event worth keeping.  A re-evaluated summary is the opposite: the retry re-ran
    // the whole pipeline and minted a fresh `output_id` with fresh quality failures and
    // a fresh hallucination rate, and `putDraft` upserts to exactly that.  Leaving the
    // item on the first attempt's evidence would show a steward one evaluation while
    // they read the draft of another, and let them accept or correct the wrong
    // immutable output record — worse the more the thread changed in between.
    //
    // A no-op on the insert-fresh path (the context is already this), so it costs one
    // statement on the branch that is already the slow one.
    await deps.reviewQueue.refreshPendingContext('flagged_hallucination', summaryId, evidence);
    await putDraft();
    deps.metrics.increment('ai.summary.withheld');
    deps.log('summary.quality.evaluated', { thread_id: threadId, passed: false });
    return { ok: true, published: false, summaryId };
  }
  await putDraft();

  // The §24.3 thread-summary Overview feature was removed, so a passing draft is
  // no longer published to a reader-facing surface — the pipeline still evaluates
  // + records it (AIOutputRecord + the AI draft store) for governance/audit.
  deps.metrics.increment('ai.summary.generated');
  deps.metrics.gauge('ai.summary.branch_coverage', draft.covered_contribution_ids.length);
  deps.log('summary.generated', {
    thread_id: threadId,
    branches: draft.covered_contribution_ids.length,
  });
  deps.log('summary.quality.evaluated', { thread_id: threadId, passed: true });
  return { ok: true, published: true, summaryId };
}

/** A user reports a summary (WS-K.1.4c). Reporter identity is never stored. */
export async function reportSummary(
  deps: SummaryPipelineDeps,
  summaryId: string,
  reason: SummaryReportReason,
  correctionText: string | null,
): Promise<SummaryReport | null> {
  // The target must be a real AI summary draft — otherwise any authenticated
  // user could pollute the steward queue + report metrics with arbitrary ids.
  if ((await deps.aiSummaries.getDraft(summaryId)) === null) return null;
  const report = summaryReportSchema.parse({
    report_id: `srep-${randomUUID()}`,
    summary_id: summaryId,
    reason,
    correction_text: correctionText,
    reported_at: new Date(deps.now()).toISOString(),
  } satisfies SummaryReport);
  await deps.aiSummaries.putReport(report);
  await deps.reviewQueue.insert({
    kind: 'reported_summary',
    subjectRef: summaryId,
    context: { reason },
    status: 'pending',
    resolution: null,
    resolvedBy: null,
  });
  deps.metrics.increment('ai.summary.reported');
  deps.metrics.increment(`ai.summary.reported.${reason}`);
  deps.log('summary.reported', { summary_id: summaryId, reason });
  return report;
}
