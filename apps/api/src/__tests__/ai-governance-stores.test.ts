// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-K in-memory store semantics: append-only inserts, lookups, list filters,
// and clear() across every store, so the abstract interfaces are exercised
// independently of the services that consume them.
import { describe, expect, it } from 'vitest';
import {
  InMemoryAiOutputRecordStore,
  InMemoryAiReviewQueueStore,
  InMemoryBlockedInvocationStore,
  InMemoryCorrectionStore,
  InMemoryDataLineageStore,
  InMemoryEvaluationStore,
  InMemoryGovernanceSummaryStore,
  InMemoryInventoryStore,
  InMemoryModelRegistryStore,
  InMemoryRiskAssessmentStore,
  InMemoryRuntimeMonitorStore,
  InMemorySummaryStore,
  InMemoryTranslationStore,
} from '../ai-governance/stores.js';

const ISO = '2026-06-19T00:00:00.000Z';

describe('WS-K stores', () => {
  it('output records: append-only, query, correction link, clear', async () => {
    const store = new InMemoryAiOutputRecordStore();
    const rec = {
      output_id: 'o1',
      model_name: 'm',
      model_version: '1.0.0',
      prompt_template_id: 't',
      config_hash: 'a'.repeat(64),
      input_refs: ['i'],
      output_ref: 'r',
      use_case_id: 'summarization' as const,
      correction_ref: null,
      timestamp: ISO,
    };
    expect(await store.put(rec)).not.toBeNull();
    expect(await store.put(rec)).toBeNull(); // append-only
    expect((await store.listByModel('m', '1.0.0')).length).toBe(1);
    expect(
      (
        await store.listByUseCase(
          'summarization',
          '2026-01-01T00:00:00.000Z',
          '2027-01-01T00:00:00.000Z',
        )
      ).length,
    ).toBe(1);
    expect((await store.linkCorrection('o1', 'c1'))?.correction_ref).toBe('c1');
    expect(await store.linkCorrection('missing', 'c1')).toBeNull();
    await store.clear();
    expect(await store.get('o1')).toBeNull();
  });

  it('registry: versions, deployed, list filters, clear', async () => {
    const store = new InMemoryModelRegistryStore();
    const base = {
      name: 'm',
      version: '1.0.0',
      card: { name: 'm', version: '1.0.0', owner: 'team', purpose: 'p' } as never,
      status: 'registered' as const,
      deprecation: null,
      registered_at: ISO,
      deployed_at: null,
    };
    await store.register(base);
    expect(await store.register(base)).toBeNull(); // versions preserved
    await store.patchStatus('m', '1.0.0', {
      status: 'deployed',
      deployed_at: ISO,
      deprecation: null,
    });
    expect((await store.getDeployed('m'))?.version).toBe('1.0.0');
    expect((await store.listVersions('m')).length).toBe(1);
    expect((await store.list({ owner: 'team' })).length).toBe(1);
    expect((await store.list({ purpose: 'nope' })).length).toBe(0);
    // Purpose filter is literal substring — LIKE metacharacters in the query
    // value are NOT wildcards. The Drizzle adapter escapes %/_ (with an ESCAPE
    // clause) to match this same contract; here 'p' contains no '%'/'_', so a
    // metacharacter query must miss.
    expect((await store.list({ purpose: '%' })).length).toBe(0);
    expect((await store.list({ purpose: '_' })).length).toBe(0);
    expect((await store.list({ purpose: 'p' })).length).toBe(1);
    expect(
      await store.patchStatus('m', '9.9.9', {
        status: 'deployed',
        deployed_at: ISO,
        deprecation: null,
      }),
    ).toBeNull();
    await store.clear();
    expect(await store.getVersion('m', '1.0.0')).toBeNull();
  });

  it('inventory: latest + version history + clear', async () => {
    const store = new InMemoryInventoryStore();
    expect(await store.latest()).toBeNull();
    await store.put({ version: 1, updated_at: ISO, use_cases: [] });
    await store.put({ version: 2, updated_at: ISO, use_cases: [] });
    expect((await store.latest())?.version).toBe(2);
    expect((await store.listVersions()).map((v) => v.version)).toEqual([1, 2]);
    await store.clear();
    expect(await store.latest()).toBeNull();
  });

  it('risk assessments + data lineage: put/get/list/clear', async () => {
    const risk = new InMemoryRiskAssessmentStore();
    await risk.put({ assessment_id: 'r1' } as never);
    expect(await risk.get('r1')).not.toBeNull();
    expect((await risk.list()).length).toBe(1);
    await risk.clear();
    expect(await risk.get('r1')).toBeNull();

    const lineage = new InMemoryDataLineageStore();
    const rec = { dataset_id: 'd', version: '1.0.0' } as never;
    expect(await lineage.put(rec)).not.toBeNull();
    expect(await lineage.put(rec)).toBeNull(); // append-only
    expect(await lineage.get('d', '1.0.0')).not.toBeNull();
    await lineage.clear();
    expect((await lineage.list()).length).toBe(0);
  });

  it('evaluations: latest + listByModel + clear', async () => {
    const store = new InMemoryEvaluationStore();
    const d = (v: string, at: string) =>
      ({
        model_name: 'm',
        version: v,
        decision: 'deploy',
        per_eval: [],
        blocked_reasons: [],
        dataset_versions: [],
        evaluated_at: at,
      }) as never;
    await store.put(d('1.0.0', '2026-06-19T00:00:00.000Z'));
    await store.put(d('1.0.0', '2026-06-20T00:00:00.000Z'));
    expect((await store.latest('m', '1.0.0'))?.evaluated_at).toBe('2026-06-20T00:00:00.000Z');
    expect((await store.listByModel('m', '1.0.0')).length).toBe(2);
    expect(await store.latest('m', '9.9.9')).toBeNull();
    await store.clear();
    expect(await store.latest('m', '1.0.0')).toBeNull();
  });

  it('corrections + blocked: list views + counts + clear', async () => {
    const corr = new InMemoryCorrectionStore();
    await corr.put({ use_case_id: 'summarization', output_id: 'o', action: 'confirm' } as never);
    expect((await corr.listByUseCase('summarization')).length).toBe(1);
    expect((await corr.listByOutput('o')).length).toBe(1);
    await corr.clear();
    expect((await corr.listByUseCase('summarization')).length).toBe(0);

    const blocked = new InMemoryBlockedInvocationStore();
    await blocked.put({ prohibition: 'investment_advice', timestamp: ISO } as never);
    expect((await blocked.list(10)).length).toBe(1);
    expect(await blocked.countByProhibition()).toEqual({ investment_advice: 1 });
    await blocked.clear();
    expect((await blocked.list(10)).length).toBe(0);
  });

  it('review queue: insert/get/list/resolve/clear', async () => {
    const store = new InMemoryAiReviewQueueStore();
    const item = await store.insert({
      kind: 'reported_summary',
      subjectRef: 's1',
      context: {},
      status: 'pending',
      resolution: null,
      resolvedBy: null,
    });
    expect(await store.get(item.reviewId)).not.toBeNull();
    expect((await store.list({ kind: 'reported_summary' }, 10)).length).toBe(1);
    const resolved = await store.resolve(item.reviewId, 'done', 'steward:1', ISO);
    expect(resolved?.status).toBe('resolved');
    expect(await store.resolve('missing', 'x', 's', ISO)).toBeNull();
    await store.clear();
    expect(await store.get(item.reviewId)).toBeNull();
  });

  it('summaries + translations + governance summaries + runtime', async () => {
    const summaries = new InMemorySummaryStore();
    await summaries.putDraft({
      summaryId: 's1',
      threadId: 't1',
      draft: {},
      outputId: 'o',
      qualityPassed: true,
      createdAt: ISO,
    });
    expect(await summaries.getDraft('s1')).not.toBeNull();
    await summaries.putReport({
      report_id: 'r',
      summary_id: 's1',
      reason: 'bias',
      correction_text: null,
      reported_at: ISO,
    });
    expect((await summaries.listReports('s1')).length).toBe(1);
    expect(await summaries.countReportsByReason()).toEqual({ bias: 1 });
    await summaries.clear();
    expect(await summaries.getDraft('s1')).toBeNull();

    const translations = new InMemoryTranslationStore();
    await translations.put({ translation_id: 'tr', source_ref: 'x', target_lang: 'es' } as never);
    expect(await translations.findBySource('x', 'es')).not.toBeNull();
    await translations.putReport({
      report_id: 'r',
      translation_id: 'tr',
      reason: 'other',
      reported_at: ISO,
    });
    expect((await translations.listReports('tr')).length).toBe(1);
    await translations.clear();
    expect(await translations.get('tr')).toBeNull();

    const gov = new InMemoryGovernanceSummaryStore();
    await gov.put({ summary_id: 'g', proposal_ref: 'p' } as never);
    expect(await gov.get('g')).not.toBeNull();
    expect((await gov.listByProposal('p')).length).toBe(1);
    await gov.clear();
    expect(await gov.get('g')).toBeNull();

    const runtime = new InMemoryRuntimeMonitorStore();
    await runtime.recordMetric({
      modelName: 'm',
      modelVersion: '1.0.0',
      metric: 'x',
      value: 1,
      recordedAt: ISO,
    });
    expect((await runtime.listMetrics('m', 'x', '2026-01-01T00:00:00.000Z')).length).toBe(1);
    await runtime.recordAlert({
      modelName: 'm',
      modelVersion: '1.0.0',
      metric: 'x',
      value: 1,
      threshold: 0.5,
      rollbackRecommendation: null,
      raisedAt: ISO,
    });
    expect((await runtime.listAlerts(10)).length).toBe(1);
    await runtime.clear();
    expect((await runtime.listAlerts(10)).length).toBe(0);
  });
});
