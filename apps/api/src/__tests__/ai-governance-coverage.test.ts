// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-K coverage: the seams the happy-path tests don't reach — the lineage
// feedback source, the wiring builders + the durable classification consumer,
// the maintenance scheduler, runtime drift/report-rate ALERTS + rollback
// recommendation, the governance null branches, the translation-consistency
// failure path, and assorted store reads.
import { randomUUID } from 'node:crypto';
import type { RegisteredModel } from '@licio/ai-governance';
import { describe, expect, it } from 'vitest';
import {
  detectMissingFields,
  detectScamPatterns,
  editGovernanceSummary,
  type GovernanceAiDeps,
  highlightConflictOfInterest,
} from '../ai-governance/governance-ai.js';
import { evaluationResultsOf } from '../ai-governance/harness.js';
import { recordLineage, registerStewardFeedbackSource } from '../ai-governance/lineage.js';
import { AiGovernanceMetrics } from '../ai-governance/metrics.js';
import { recordAiOutput } from '../ai-governance/output-records.js';
import { deployModel, type RegistryDeps } from '../ai-governance/registry.js';
import {
  evaluateModelRuntime,
  type RuntimeMonitorDeps,
  recommendRollback,
} from '../ai-governance/runtime-monitor.js';
import { runAiGovernanceTick, startAiGovernanceScheduler } from '../ai-governance/scheduler.js';
import { seedAiGovernance } from '../ai-governance/seed.js';
import {
  type AiGovernanceServices,
  createInMemoryAiGovernanceServices,
  getAiGovernanceServices,
  setAiGovernanceServices,
  tryGetAiGovernanceServices,
} from '../ai-governance/services.js';
import { type TranslationDeps, translateContent } from '../ai-governance/translation.js';
import {
  buildCorrectionDeps,
  buildGovernanceAiDeps,
  buildLineageDeps,
  buildPipelineDeps,
  buildRuntimeMonitorDeps,
  buildSummaryDeps,
  registerAiGovernanceConsumers,
} from '../ai-governance/wiring.js';
import { freshForumServices, seedThread } from './forum-test-helpers.js';

const NOW = () => Date.parse('2026-06-19T12:00:00.000Z');

function fresh(): { forum: ReturnType<typeof freshForumServices>; ai: AiGovernanceServices } {
  const forum = freshForumServices();
  const ai = createInMemoryAiGovernanceServices(forum.events, { now: NOW });
  ai.ingestion = forum.ingestion;
  ai.forum = forum.forum;
  return { forum, ai };
}

describe('WS-K metrics', () => {
  it('counts, gauges, snapshots, and clears', () => {
    const m = new AiGovernanceMetrics();
    m.increment('a', 2);
    m.gauge('g', 0.5);
    expect(m.counter('a')).toBe(2);
    expect(m.snapshot()).toEqual({ counters: { a: 2 }, gauges: { g: 0.5 } });
    m.clear();
    expect(m.counter('a')).toBe(0);
  });
});

describe('WS-K services singleton', () => {
  it('set/get/tryGet and reloadConfig', async () => {
    const { ai } = fresh();
    setAiGovernanceServices(ai);
    expect(getAiGovernanceServices()).toBe(ai);
    expect(tryGetAiGovernanceServices()).toBe(ai);
    await expect(ai.reloadConfig()).resolves.toMatchObject({ topicConfidenceThreshold: 0.7 });
  });
});

describe('WS-K.1.1e lineage feedback source', () => {
  it('records a non-user-derived usable dataset and rejects a missing predecessor', async () => {
    const { ai } = fresh();
    const deps = buildLineageDeps(ai);
    const ok = await recordLineage(deps, {
      dataset_id: 'corpus',
      version: '1.0.0',
      source: 'public corpus',
      consent_basis: 'public license',
      contains_user_derived: false,
      transformations: [],
      privacy_review_ref: null,
      used_by: [],
      predecessor_dataset_id: null,
      usable: true,
      created_at: '2026-06-19T00:00:00.000Z',
    });
    expect(ok.ok).toBe(true);
    const missing = await recordLineage(deps, {
      dataset_id: 'v2',
      version: '2.0.0',
      source: 'public corpus',
      consent_basis: 'public license',
      contains_user_derived: false,
      transformations: [],
      privacy_review_ref: null,
      used_by: [],
      predecessor_dataset_id: 'ghost',
      usable: true,
      created_at: '2026-06-19T00:00:00.000Z',
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.code).toBe('predecessor_missing');
  });

  it('marks steward feedback usable only with a privacy review', async () => {
    const { ai } = fresh();
    const deps = buildLineageDeps(ai);
    const reviewed = await registerStewardFeedbackSource(deps, {
      datasetId: 'fb-1',
      version: '1.0.0',
      privacyReviewRef: 'pr:1',
      actor: 'ai-governance',
      predecessorDatasetId: null,
      usedBy: [],
      nowIso: '2026-06-19T00:00:00.000Z',
    });
    expect(reviewed.ok).toBe(true);
    if (reviewed.ok) expect(reviewed.record.usable).toBe(true);
    const unreviewed = await registerStewardFeedbackSource(deps, {
      datasetId: 'fb-2',
      version: '1.0.0',
      privacyReviewRef: null,
      actor: 'ai-governance',
      predecessorDatasetId: null,
      usedBy: [],
      nowIso: '2026-06-19T00:00:00.000Z',
    });
    expect(unreviewed.ok).toBe(true);
    if (unreviewed.ok) expect(unreviewed.record.usable).toBe(false);
  });
});

describe('WS-K wiring builders + classification consumer', () => {
  it('builds every dependency bundle', () => {
    const { ai } = fresh();
    expect(buildCorrectionDeps(ai)).toBeDefined();
    expect(buildGovernanceAiDeps(ai)).toBeDefined();
    expect(buildRuntimeMonitorDeps(ai)).toBeDefined();
    expect(buildSummaryDeps(ai)).toBeDefined();
    expect(buildPipelineDeps(ai)).toBeDefined();
  });

  it('classifies a story when a content.normalized event arrives', async () => {
    const { forum, ai } = fresh();
    registerAiGovernanceConsumers(forum.events, ai);
    const { storyId } = await seedThread(forum, { title: 'Climate policy bill vote senate' });
    await forum.events.router.publish({
      event_id: randomUUID(),
      timestamp: '2026-06-19T12:00:00.000Z',
      schema_version: '1',
      event_type: 'content.normalized',
      story_id: storyId,
      submitted_by: randomUUID(),
      submission_type: 'link',
      canonical_url: 'https://example.com/a',
      topic_ids: [],
      room_id: '00000000-0000-4000-8000-000000000001',
      visibility: 'public',
      privacy_classification: 'public',
      retention_tier: 'public_contribution',
      source_id: null,
      language: 'en',
      sensitivity_labels: [],
      duplicate_group_id: null,
      claim_ids: [],
      embedding_ref: null,
    } as never);
    // The consumer wrote a classification output record for the story.
    const records = await ai.outputRecords.listByUseCase(
      'topic_classification',
      '2026-01-01T00:00:00.000Z',
      '2027-01-01T00:00:00.000Z',
    );
    expect(records.some((r) => r.output_ref === storyId)).toBe(true);
  });

  it('invokes the post-classification hook so ranking features refresh (WS-I cold-start)', async () => {
    const { forum, ai } = fresh();
    const refreshed: string[] = [];
    registerAiGovernanceConsumers(forum.events, ai, async (storyId) => {
      refreshed.push(storyId);
    });
    const { storyId } = await seedThread(forum, { title: 'Climate policy bill vote senate' });
    await forum.events.router.publish({
      event_id: randomUUID(),
      timestamp: '2026-06-19T12:00:00.000Z',
      schema_version: '1',
      event_type: 'content.normalized',
      story_id: storyId,
      submitted_by: randomUUID(),
      submission_type: 'link',
      canonical_url: 'https://example.com/b',
      topic_ids: [],
      room_id: '00000000-0000-4000-8000-000000000001',
      visibility: 'public',
      privacy_classification: 'public',
      retention_tier: 'public_contribution',
      source_id: null,
      language: 'en',
      sensitivity_labels: [],
      duplicate_group_id: null,
      claim_ids: [],
      embedding_ref: null,
    } as never);
    // The hook fired with the classified story, so the boot wiring can refresh
    // that story's ranking feature vector off the validated topics.
    expect(refreshed).toContain(storyId);
  });
});

describe('WS-K.1.2f runtime alerts + rollback', () => {
  it('raises a drift alert and recommends the prior version', async () => {
    const { ai } = fresh();
    await seedAiGovernance(ai);
    // Register a prior version so a rollback can be recommended.
    const deployed = (await ai.registry.getDeployed('thread-summarizer')) as RegisteredModel;
    await ai.registry.register({
      ...deployed,
      version: '0.9.0',
      card: { ...deployed.card, version: '0.9.0' },
      status: 'registered',
      deployed_at: null,
      registered_at: '2026-06-18T00:00:00.000Z',
    });
    expect(await recommendRollback(buildRuntimeMonitorDeps(ai), 'thread-summarizer', '1.0.0')).toBe(
      '0.9.0',
    );

    // Output volume: 1 in the prior window, 5 in the current window ⇒ big drift.
    const nowMs = NOW();
    const at = (msAgo: number) => new Date(nowMs - msAgo).toISOString();
    await recordAiOutput(ai.outputRecords, {
      modelName: 'thread-summarizer',
      modelVersion: '1.0.0',
      promptTemplateId: 't',
      config: {},
      inputRefs: ['x'],
      outputRef: 'x',
      useCaseId: 'summarization',
      nowIso: at(90 * 60_000),
    });
    for (let i = 0; i < 5; i += 1) {
      await recordAiOutput(ai.outputRecords, {
        modelName: 'thread-summarizer',
        modelVersion: '1.0.0',
        promptTemplateId: 't',
        config: {},
        inputRefs: [`y${i}`],
        outputRef: `y${i}`,
        useCaseId: 'summarization',
        nowIso: at(20 * 60_000),
      });
    }
    // A spike in summary reports drives the user-report-rate alert too.
    for (let i = 0; i < 4; i += 1) {
      await ai.summaries.putReport({
        report_id: `r${i}`,
        summary_id: `s${i}`,
        reason: 'factual_error',
        correction_text: null,
        reported_at: at(10 * 60_000),
      });
    }
    const deps: RuntimeMonitorDeps = buildRuntimeMonitorDeps(ai);
    await evaluateModelRuntime(
      deps,
      (await ai.registry.getDeployed('thread-summarizer')) as RegisteredModel,
    );
    const alerts = await ai.runtime.listAlerts(10);
    expect(alerts.length).toBeGreaterThan(0);
    expect(alerts.some((a) => a.metric === 'output_rate_drift')).toBe(true);
    expect(alerts.some((a) => a.rollbackRecommendation === '0.9.0')).toBe(true);
  });
});

describe('WS-K scheduler tick', () => {
  it('runs config reload + runtime monitor + accuracy without error', async () => {
    const { ai } = fresh();
    await seedAiGovernance(ai);
    const errors: string[] = [];
    await runAiGovernanceTick(ai, (_e, task) => errors.push(task));
    expect(errors).toEqual([]);
  });

  it('reports a task error when a stage throws (fail-isolated)', async () => {
    const { ai } = fresh();
    ai.reloadConfig = async () => {
      throw new Error('boom');
    };
    const errors: string[] = [];
    await runAiGovernanceTick(ai, (_e, task) => errors.push(task));
    expect(errors).toContain('config_reload');
  });

  it('starts and stops the hourly scheduler', () => {
    const { ai } = fresh();
    const stop = startAiGovernanceScheduler(ai, () => {}, 3_600_000, {
      lease: { tryAcquire: async () => false },
    });
    expect(typeof stop).toBe('function');
    stop();
  });
});

describe('WS-K wiring null-seam guards + registry demotion', () => {
  it('throws when a required seam is not wired', () => {
    const forum = freshForumServices();
    const ai = createInMemoryAiGovernanceServices(forum.events, { now: NOW });
    // ingestion/forum left null.
    expect(() => buildSummaryDeps(ai)).toThrow(/seam not wired/);
    expect(() => buildPipelineDeps(ai)).toThrow(/ingestion seam/);
  });

  it('demotes a previously-deployed version when a new one deploys', async () => {
    const { ai } = fresh();
    await seedAiGovernance(ai);
    const deployed = (await ai.registry.getDeployed('thread-summarizer')) as RegisteredModel;
    // Register + record a passing evaluation for a v2, then deploy it.
    await ai.registry.register({
      ...deployed,
      version: '2.0.0',
      card: { ...deployed.card, version: '2.0.0' },
      status: 'registered',
      deployed_at: null,
      registered_at: '2026-06-19T06:00:00.000Z',
    });
    await ai.evaluations.put({
      model_name: 'thread-summarizer',
      version: '2.0.0',
      decision: 'deploy',
      per_eval: [],
      blocked_reasons: [],
      dataset_versions: [],
      evaluated_at: '2026-06-19T06:00:00.000Z',
    });
    const deps: RegistryDeps = {
      registry: ai.registry,
      riskAssessments: ai.riskAssessments,
      lineage: ai.lineage,
      evaluations: ai.evaluations,
      metrics: ai.metrics,
      log: ai.log,
      now: ai.now,
    };
    const result = await deployModel(deps, 'thread-summarizer', '2.0.0');
    expect(result.ok).toBe(true);
    // The old version is demoted to registered; v2 is the deployed one.
    expect((await ai.registry.getDeployed('thread-summarizer'))?.version).toBe('2.0.0');
    expect((await ai.registry.getVersion('thread-summarizer', '1.0.0'))?.status).toBe('registered');
  });
});

describe('WS-K.2.2a governance null branches', () => {
  function deps(ai: AiGovernanceServices): GovernanceAiDeps {
    return buildGovernanceAiDeps(ai);
  }
  it('returns no advisory when there is no overlap or no scam markers', async () => {
    const { ai } = fresh();
    expect(detectMissingFields({ budget: '1', recipient: 'a', citations: 'c' })).toEqual([]);
    expect(await highlightConflictOfInterest(deps(ai), 'p', 'alice', 'bob')).toBeNull();
    expect(await detectScamPatterns(deps(ai), 'p', 'A perfectly ordinary proposal.')).toBeNull();
    expect(await editGovernanceSummary(deps(ai), 'missing', 'x')).toBeNull();
  });
});

describe('WS-K.2.1a translation consistency failure', () => {
  it('flags a translation that invents a number', async () => {
    const { ai } = fresh();
    const deps: TranslationDeps = {
      translations: ai.translations,
      provider: { translate: async () => 'Se recaudaron 999 millones.' }, // invented number
      outputRecords: ai.outputRecords,
      reviewQueue: ai.reviewQueue,
      guard: ai.guard,
      metrics: ai.metrics,
      log: ai.log,
      now: ai.now,
    };
    const translation = await translateContent(deps, {
      sourceKind: 'story',
      sourceRef: 's-inc',
      sourceText: 'Revenue was reported.',
      sourceLang: 'en',
      targetLang: 'es',
    });
    expect(translation.consistency_passed).toBe(false);
    const pending = await ai.reviewQueue.list({ kind: 'reported_translation' }, 10);
    expect(pending.length).toBeGreaterThan(0);
  });
});

describe('WS-K harness helper', () => {
  it('extracts per-eval results from a decision', () => {
    expect(
      evaluationResultsOf({
        model_name: 'm',
        version: '1.0.0',
        decision: 'deploy',
        per_eval: [],
        blocked_reasons: [],
        dataset_versions: [],
        evaluated_at: '2026-06-19T00:00:00.000Z',
      }),
    ).toEqual([]);
  });
});
