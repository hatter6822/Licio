// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-K application pipelines: topic classification (apply/suggest + AI-classified
// label), claim extraction (AI-draft), summary generation (quality + grounding
// gate → publish/withhold), translation (AI-translated + consistency), correction
// + accuracy, governance AI (cited fields, uncertainty, COI/scam advisories,
// prohibited capabilities blocked), and runtime monitoring.
import { describe, expect, it } from 'vitest';
import {
  accuracyMetrics,
  type CorrectionDeps,
  recordCorrection,
} from '../ai-governance/correction.js';
import {
  detectScamPatterns,
  editGovernanceSummary,
  type GovernanceAiDeps,
  highlightConflictOfInterest,
  summarizeProposal,
} from '../ai-governance/governance-ai.js';
import { recordAiOutput } from '../ai-governance/output-records.js';
import {
  classifyStoryTopics,
  extractStoryClaims,
  type PipelineDeps,
} from '../ai-governance/pipelines.js';
import { type RuntimeMonitorDeps, runtimeMonitorTick } from '../ai-governance/runtime-monitor.js';
import { seedAiGovernance } from '../ai-governance/seed.js';
import {
  type AiGovernanceServices,
  createInMemoryAiGovernanceServices,
} from '../ai-governance/services.js';
import {
  generateThreadSummary,
  reportSummary,
  type SummaryPipelineDeps,
} from '../ai-governance/summaries.js';
import {
  reportTranslation,
  type TranslationDeps,
  translateContent,
} from '../ai-governance/translation.js';
import { freshForumServices, seedThread } from './forum-test-helpers.js';

const NOW = () => Date.parse('2026-06-19T00:00:00.000Z');

interface Fixture {
  forum: ReturnType<typeof freshForumServices>;
  ai: AiGovernanceServices;
}

function fresh(): Fixture {
  const forum = freshForumServices();
  const ai = createInMemoryAiGovernanceServices(forum.events, { now: NOW });
  return { forum, ai };
}

function pipelineDeps(f: Fixture): PipelineDeps {
  return {
    stories: f.forum.ingestion.stories,
    outputRecords: f.ai.outputRecords,
    reviewQueue: f.ai.reviewQueue,
    guard: f.ai.guard,
    topicConfidenceThreshold: () => f.ai.config().topicConfidenceThreshold,
    claimConfidenceFloor: () => f.ai.config().claimConfidenceFloor,
    metrics: f.ai.metrics,
    log: f.ai.log,
    now: f.ai.now,
  };
}

describe('WS-K.1.3a topic classification', () => {
  it('applies above-threshold labels and suggests sub-threshold ones', async () => {
    const f = fresh();
    const { storyId } = await seedThread(f.forum, {
      title: 'Climate policy bill vote in the senate',
    });
    const result = await classifyStoryTopics(pipelineDeps(f), storyId);
    expect(result).not.toBeNull();
    const applied = result?.assignments.filter((a) => a.applied) ?? [];
    expect(applied.length).toBeGreaterThan(0);
    expect(applied.every((a) => a.label === 'AI-classified')).toBe(true);
    // The applied topics are merged into the story for WS-I retrieval.
    const story = await f.forum.ingestion.stories.getById(storyId);
    expect(story?.topicIds).toEqual(expect.arrayContaining(applied.map((a) => a.topic_id)));
    // An AIOutputRecord was written.
    expect(await f.ai.outputRecords.get(result?.output_id ?? '')).not.toBeNull();
  });

  it('returns null for an unknown story', async () => {
    const f = fresh();
    expect(await classifyStoryTopics(pipelineDeps(f), 'missing')).toBeNull();
  });
});

describe('WS-K.1.3b claim extraction', () => {
  it('extracts AI-draft claims with an output record', async () => {
    const f = fresh();
    const { storyId } = await seedThread(f.forum, { title: 'Reservoir update' });
    const body =
      'The reservoir level fell by 12 percent in May. Officials confirmed the new policy passed.';
    const result = await extractStoryClaims(pipelineDeps(f), storyId, body);
    expect(result?.claims.length).toBeGreaterThan(0);
    expect(result?.claims.every((c) => c.label === 'AI-draft')).toBe(true);
    expect(result?.claims.every((c) => c.source_passage.length > 0)).toBe(true);
    expect(await f.ai.outputRecords.get(result?.output_id ?? '')).not.toBeNull();
  });
});

describe('WS-K.1.4a summary generation', () => {
  function summaryDeps(f: Fixture): SummaryPipelineDeps {
    return {
      contributions: f.forum.forum.contributions,
      forumSummaries: f.forum.forum.summaries,
      stories: f.forum.ingestion.stories,
      aiSummaries: f.ai.summaries,
      outputRecords: f.ai.outputRecords,
      reviewQueue: f.ai.reviewQueue,
      guard: f.ai.guard,
      minActivity: () => f.ai.config().summaryMinActivity,
      metrics: f.ai.metrics,
      log: f.ai.log,
      now: f.ai.now,
    };
  }

  async function seedRoots(f: Fixture, threadId: string, bodies: string[]): Promise<void> {
    let i = 0;
    for (const body of bodies) {
      i += 1;
      await f.forum.forum.contributions.insert({
        contributionId: `c-${i}-${threadId.slice(0, 6)}`,
        threadId,
        userId: `u-${i}`,
        type: 'comment',
        body,
        citations: [],
        metadata: {},
        targetClaimId: null,
        parentContributionId: null,
        clientDraftId: `d-${i}-${threadId.slice(0, 6)}`,
        path: [],
        moderationState: 'published',
      });
    }
  }

  it('publishes an automated draft that passes quality + grounding', async () => {
    const f = fresh();
    const { threadId } = await seedThread(f.forum);
    await seedRoots(f, threadId, [
      'The city council approved the new budget on Tuesday.',
      'Some residents argue the budget favors downtown over the suburbs.',
      'Will the budget be revisited next quarter?',
    ]);
    const outcome = await generateThreadSummary(summaryDeps(f), threadId);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.published).toBe(true);
    const summaries = await f.forum.forum.summaries.listByThread(threadId);
    expect(summaries.some((s) => s.layer === 'automated_draft')).toBe(true);
  });

  it('skips a thread below the activity threshold', async () => {
    const f = fresh();
    const { threadId } = await seedThread(f.forum);
    await seedRoots(f, threadId, ['One comment only.']);
    const outcome = await generateThreadSummary(summaryDeps(f), threadId);
    expect(outcome.ok).toBe(false);
  });

  it('withholds and routes to review a summary that reproduces a slur', async () => {
    const f = fresh();
    const { threadId } = await seedThread(f.forum);
    await seedRoots(f, threadId, [
      'The council approved the budget.',
      'You are all idiot people who ruin everything.',
      'Will it be revisited?',
    ]);
    const outcome = await generateThreadSummary(summaryDeps(f), threadId);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.published).toBe(false);
    const pending = await f.ai.reviewQueue.list({ status: 'pending' }, 10);
    expect(pending.some((r) => r.kind === 'flagged_hallucination')).toBe(true);
  });

  it('records a user report and routes it to review', async () => {
    const f = fresh();
    await reportSummary(summaryDeps(f), 'sum-1', 'fake_citation', 'citation does not exist');
    const reports = await f.ai.summaries.listReports('sum-1');
    expect(reports[0]?.reason).toBe('fake_citation');
    const pending = await f.ai.reviewQueue.list({ kind: 'reported_summary' }, 10);
    expect(pending).toHaveLength(1);
  });
});

describe('WS-K.2.1a translation', () => {
  function translationDeps(f: Fixture): TranslationDeps {
    return {
      translations: f.ai.translations,
      provider: f.ai.translationProvider,
      outputRecords: f.ai.outputRecords,
      reviewQueue: f.ai.reviewQueue,
      guard: f.ai.guard,
      metrics: f.ai.metrics,
      log: f.ai.log,
      now: f.ai.now,
    };
  }

  it('translates with the AI-translated label and the original accessible', async () => {
    const f = fresh();
    const translation = await translateContent(translationDeps(f), {
      sourceKind: 'story',
      sourceRef: 'story-1',
      sourceText: 'The vote passed on Tuesday.',
      sourceLang: 'en',
      targetLang: 'es',
    });
    expect(translation.label).toBe('AI-translated');
    expect(translation.source_ref).toBe('story-1');
    expect(translation.consistency_passed).toBe(true);
    // Idempotent for the same (source, target).
    const again = await translateContent(translationDeps(f), {
      sourceKind: 'story',
      sourceRef: 'story-1',
      sourceText: 'The vote passed on Tuesday.',
      sourceLang: 'en',
      targetLang: 'es',
    });
    expect(again.translation_id).toBe(translation.translation_id);
  });

  it('records a translation report', async () => {
    const f = fresh();
    const translation = await translateContent(translationDeps(f), {
      sourceKind: 'contribution',
      sourceRef: 'c-1',
      sourceText: 'Hello',
      sourceLang: 'en',
      targetLang: 'fr',
    });
    const report = await reportTranslation(
      translationDeps(f),
      translation.translation_id,
      'mistranslation',
    );
    expect(report.reason).toBe('mistranslation');
  });
});

describe('WS-K.1.3c correction + accuracy', () => {
  function correctionDeps(f: Fixture): CorrectionDeps {
    return {
      corrections: f.ai.corrections,
      outputRecords: f.ai.outputRecords,
      metrics: f.ai.metrics,
      log: f.ai.log,
      now: f.ai.now,
    };
  }

  it('records a correction linked to its output record and computes accuracy', async () => {
    const f = fresh();
    const output = await recordAiOutput(f.ai.outputRecords, {
      modelName: 'topic-classifier',
      modelVersion: '1.0.0',
      promptTemplateId: 't',
      config: {},
      inputRefs: ['s1'],
      outputRef: 's1',
      useCaseId: 'topic_classification',
      nowIso: '2026-06-19T00:00:00.000Z',
    });
    const result = await recordCorrection(correctionDeps(f), {
      outputId: output.output_id,
      useCaseId: 'topic_classification',
      action: 'modify',
      originalValue: 'climate',
      correctedValue: 'policy',
      stewardRef: 'steward:1',
      category: 'climate',
    });
    expect(result.ok).toBe(true);
    const linked = await f.ai.outputRecords.get(output.output_id);
    expect(linked?.correction_ref).not.toBeNull();
    const metrics = await accuracyMetrics(correctionDeps(f), 'topic_classification');
    expect(metrics.total).toBe(1);
    expect(metrics.correction_rate).toBe(1);
  });

  it('rejects a correction for an unknown output', async () => {
    const f = fresh();
    const result = await recordCorrection(correctionDeps(f), {
      outputId: 'missing',
      useCaseId: 'summarization',
      action: 'confirm',
      originalValue: 'x',
      correctedValue: null,
      stewardRef: 'steward:1',
      category: null,
    });
    expect(result.ok).toBe(false);
  });
});

describe('WS-K.2.2a governance AI', () => {
  function govDeps(f: Fixture): GovernanceAiDeps {
    return {
      governanceSummaries: f.ai.governanceSummaries,
      outputRecords: f.ai.outputRecords,
      guard: f.ai.guard,
      metrics: f.ai.metrics,
      log: f.ai.log,
      now: f.ai.now,
    };
  }

  it('summarizes a proposal citing fields and flagging missing ones', async () => {
    const f = fresh();
    const summary = await summarizeProposal(govDeps(f), {
      proposalRef: 'p1',
      fields: { budget: '1000 USDC', recipient: 'Alice' }, // citations missing
    });
    expect(summary.cited_fields).toEqual(expect.arrayContaining(['budget', 'recipient']));
    expect(summary.uncertainty_flagged).toBe(true);
    expect(summary.label).toBe('machine-generated');
    expect(summary.contestable).toBe(true);
  });

  it('flags a conflict of interest and a scam pattern (advisory only)', async () => {
    const f = fresh();
    const coi = await highlightConflictOfInterest(govDeps(f), 'p1', 'Alice', 'Alice');
    expect(coi?.advisory_only).toBe(true);
    expect(coi?.kind).toBe('coi_highlight');
    const scam = await detectScamPatterns(
      govDeps(f),
      'p1',
      'Send funds to this wallet for guaranteed returns!',
    );
    expect(scam?.kind).toBe('scam_pattern');
  });

  it('lets a steward edit/contest a summary (non-final)', async () => {
    const f = fresh();
    const summary = await summarizeProposal(govDeps(f), {
      proposalRef: 'p2',
      fields: { budget: '5' },
    });
    const edited = await editGovernanceSummary(
      govDeps(f),
      summary.summary_id,
      'Steward-revised summary.',
    );
    expect(edited?.steward_edited).toBe(true);
    expect(edited?.body).toBe('Steward-revised summary.');
  });

  it('blocks a prohibited governance capability before execution', async () => {
    const f = fresh();
    await expect(
      f.ai.guard.enforce({
        use_case_id: 'governance_assistance',
        capability: 'gov_wealth_feed_personalization',
        caller: 'attacker',
        effect: 'advisory',
        uses_wealth_signals: false,
        targets_risk_identity: false,
      }),
    ).rejects.toThrow();
    const blocked = await f.ai.blocked.list(10);
    expect(blocked[0]?.prohibition).toBe('wealth_based_profiling');
  });
});

describe('WS-K.1.2f runtime monitoring', () => {
  it('records runtime metrics for deployed models', async () => {
    const f = fresh();
    await seedAiGovernance(f.ai);
    const deps: RuntimeMonitorDeps = {
      registry: f.ai.registry,
      outputRecords: f.ai.outputRecords,
      summaries: f.ai.summaries,
      runtime: f.ai.runtime,
      config: f.ai.config,
      metrics: f.ai.metrics,
      log: f.ai.log,
      now: f.ai.now,
    };
    await runtimeMonitorTick(deps);
    const metrics = await f.ai.runtime.listMetrics(
      'thread-summarizer',
      'output_count',
      '2026-01-01T00:00:00.000Z',
    );
    expect(metrics.length).toBeGreaterThan(0);
    // A single deployed version has no prior version to roll back to.
    const { recommendRollback } = await import('../ai-governance/runtime-monitor.js');
    expect(await recommendRollback(deps, 'thread-summarizer', '1.0.0')).toBeNull();
  });
});
