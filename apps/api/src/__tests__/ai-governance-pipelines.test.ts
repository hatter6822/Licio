// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-K application pipelines: topic classification (apply/suggest + AI-classified
// label), claim extraction (AI-draft), summary generation (quality + grounding
// gate → publish/withhold), translation (AI-translated + consistency), correction
// + accuracy, governance AI (cited fields, uncertainty, COI/scam advisories,
// prohibited capabilities blocked), and runtime monitoring.
import { topicIdForSlug, UNCLASSIFIED_TOPIC_ID } from '@licio/shared';
import { describe, expect, it, vi } from 'vitest';
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
import { runSummarySweep, SUMMARY_SWEEP_CURSOR } from '../ai-governance/scheduler.js';
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
import { captionTextFromVtt } from '../forum/video.js';
import { recomputeFreshness } from '../ingestion/freshness.js';
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
    sources: f.forum.ingestion.sources,
    freshness: f.forum.ingestion.freshness,
    outputRecords: f.ai.outputRecords,
    reviewQueue: f.ai.reviewQueue,
    guard: f.ai.guard,
    topicConfidenceThreshold: () => f.ai.config().topicConfidenceThreshold,
    claimConfidenceFloor: () => f.ai.config().claimConfidenceFloor,
    // WS-K §24.1 — the caption-track reader (parity with buildPipelineDeps): read
    // the WebVTT bytes from the forum upload store, strip to plain text.
    readCaptionText: async (uploadId: string): Promise<string | null> => {
      const bytes = await f.forum.forum.uploads.getBytes(uploadId);
      return bytes === null ? null : captionTextFromVtt(bytes);
    },
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

  it('validates supported author proposals and REJECTS unsupported ones (SPEC §24.1)', async () => {
    const f = fresh();
    const climate = topicIdForSlug('climate-environment'); // supported by the title
    const health = topicIdForSlug('health'); // NOT supported by the title
    const { storyId } = await seedThread(f.forum, {
      // Multiple climate keywords clear the confidence threshold; no health ones.
      title: 'Climate carbon emissions drought and renewable water levels',
      proposedTopicIds: [climate, health],
    });
    await classifyStoryTopics(pipelineDeps(f), storyId);
    const story = await f.forum.ingestion.stories.getById(storyId);
    // The content-supported proposal becomes trusted; the unsupported one does not.
    expect(story?.topicIds).toContain(climate);
    expect(story?.topicIds).not.toContain(health);
    // The trusted set is real (not the sentinel) since something validated.
    expect(story?.topicIds).not.toContain(UNCLASSIFIED_TOPIC_ID);
    // A rejected author proposal is recorded for steward review.
    const review = await f.ai.reviewQueue.list({ status: 'pending' }, 50);
    expect(
      review.some(
        (r) =>
          r.kind === 'low_confidence_classification' &&
          (r.context as Record<string, unknown>)['topic_id'] === health &&
          (r.context as Record<string, unknown>)['rejected_author_proposal'] === true,
      ),
    ).toBe(true);
  });

  it('carries the UNCLASSIFIED sentinel when nothing validates', async () => {
    const f = fresh();
    const { storyId } = await seedThread(f.forum, {
      title: 'The annual photography contest winners announced',
      proposedTopicIds: [topicIdForSlug('health')],
    });
    await classifyStoryTopics(pipelineDeps(f), storyId);
    const story = await f.forum.ingestion.stories.getById(storyId);
    expect(story?.topicIds).toEqual([UNCLASSIFIED_TOPIC_ID]);
  });

  it('validates a video topic evidenced ONLY in an uploaded caption track (WS-K §24.1)', async () => {
    const f = fresh();
    const tech = topicIdForSlug('technology');
    const captionsUploadId = '22222222-2222-4222-8222-222222222222';
    // Store the WebVTT track: the technology keywords live ONLY in the captions,
    // not the title, and there is no inline `captions_text`.
    await f.forum.forum.uploads.put(
      {
        uploadId: captionsUploadId,
        ownerUserId: null,
        contentType: 'text/vtt',
        byteSize: 0,
        altText: null,
        storageRef: 'ref',
        metadataStripped: true,
        scanState: 'clear',
      },
      new TextEncoder().encode(
        'WEBVTT\n\n1\n00:00:00.000 --> 00:00:04.000\nThe new software algorithm runs on\n\n2\n00:00:04.000 --> 00:00:08.000\nevery computer chip in the datacenter.',
      ),
    );
    const { storyId } = await seedThread(f.forum, {
      title: 'A short clip', // carries no technology keywords
      proposedTopicIds: [tech],
      submissionMetadata: {
        submission_type: 'video_post',
        upload_id: '33333333-3333-4333-8333-333333333333',
        captions_upload_id: captionsUploadId,
      },
    });
    await classifyStoryTopics(pipelineDeps(f), storyId);
    const story = await f.forum.ingestion.stories.getById(storyId);
    // The caption evidence validated the author's proposal — not left UNCLASSIFIED.
    expect(story?.topicIds).toContain(tech);
    expect(story?.topicIds).not.toContain(UNCLASSIFIED_TOPIC_ID);
  });

  it('validates a topic from EPHEMERAL override text and consumes the proposals (WS-K §24.1)', async () => {
    const f = fresh();
    const tech = topicIdForSlug('technology');
    // A story whose persisted text (title + body + null excerpt) carries NO
    // technology keywords — the noarchive-link shape, where the evidence lives
    // only in the ephemeral fetched body passed as overrideText.
    const { storyId } = await seedThread(f.forum, {
      title: 'A short update',
      body: 'Neutral body with no topical keywords.',
      excerpt: null,
      proposedTopicIds: [tech],
    });
    await classifyStoryTopics(pipelineDeps(f), storyId, {
      overrideText: 'The new software algorithm runs on every computer chip.',
    });
    const story = await f.forum.ingestion.stories.getById(storyId);
    expect(story?.topicIds).toContain(tech);
    // The override run is AUTHORITATIVE: proposals are consumed…
    expect(story?.proposedTopicIds).toEqual([]);
    // …so the deferred, body-blind re-run PRESERVES the topic instead of
    // re-adjudicating it to UNCLASSIFIED.
    await classifyStoryTopics(pipelineDeps(f), storyId);
    const after = await f.forum.ingestion.stories.getById(storyId);
    expect(after?.topicIds).toContain(tech);
    expect(after?.topicIds).not.toContain(UNCLASSIFIED_TOPIC_ID);
  });

  it('drops a pre-catalog placeholder topic on reclassification with no proposals (WS-K)', async () => {
    const f = fresh();
    // A legacy row: the pre-catalog composer stored a random UUID as `topic_ids`
    // and `proposed_topic_ids` is empty. The title carries no catalog keywords.
    const placeholder = '11111111-1111-4111-8111-111111111111';
    const { storyId } = await seedThread(f.forum, {
      title: 'The annual photography contest winners announced',
      topicIds: [placeholder],
      proposedTopicIds: [],
    });
    await classifyStoryTopics(pipelineDeps(f), storyId);
    const story = await f.forum.ingestion.stories.getById(storyId);
    // The random placeholder never survives into the trusted set.
    expect(story?.topicIds).not.toContain(placeholder);
    expect(story?.topicIds).toEqual([UNCLASSIFIED_TOPIC_ID]);
  });

  it('preserves an existing CATALOG topic on reclassification with no proposals (WS-K)', async () => {
    const f = fresh();
    const climate = topicIdForSlug('climate-environment');
    const { storyId } = await seedThread(f.forum, {
      title: 'The annual photography contest winners announced', // no catalog keywords
      topicIds: [climate],
      proposedTopicIds: [],
    });
    await classifyStoryTopics(pipelineDeps(f), storyId);
    const story = await f.forum.ingestion.stories.getById(storyId);
    // A genuine catalog topic on a legacy/backfill row is retained, not destroyed.
    expect(story?.topicIds).toContain(climate);
  });

  it('validates a proposal supported only by the submission body when there is no excerpt (SPEC §24.1)', async () => {
    const f = fresh();
    const climate = topicIdForSlug('climate-environment');
    const { storyId } = await seedThread(f.forum, {
      title: 'A short note', // no catalog keywords in the title
      body: 'Climate carbon emissions drought and renewable water levels',
      excerpt: null, // a robots-disallowed / noarchive link stores no excerpt
      proposedTopicIds: [climate],
    });
    await classifyStoryTopics(pipelineDeps(f), storyId);
    const story = await f.forum.ingestion.stories.getById(storyId);
    // The reason (submission body) names the topic, so the proposal validates
    // instead of being rejected for lack of a fetched excerpt.
    expect(story?.topicIds).toContain(climate);
    expect(story?.topicIds).not.toContain(UNCLASSIFIED_TOPIC_ID);
  });

  it('an unclassified story derives no topic-cadence freshness baseline (sentinel excluded)', async () => {
    const f = fresh();
    // Two stories both carrying ONLY the UNCLASSIFIED sentinel.
    const a = await seedThread(f.forum, {
      title: 'A',
      topicIds: [UNCLASSIFIED_TOPIC_ID],
    });
    await seedThread(f.forum, { title: 'B', topicIds: [UNCLASSIFIED_TOPIC_ID] });
    const storyA = await f.forum.ingestion.stories.getById(a.storyId);
    if (storyA === null) throw new Error('seed failed');
    // Window anchored to the story's own creation so both stories fall inside.
    await recomputeFreshness(
      f.forum.ingestion.stories,
      f.forum.ingestion.freshness,
      storyA,
      Date.parse(storyA.createdAt) + 1000,
    );
    // The sentinel is excluded, so two unclassified stories never derive a
    // common topic-cadence baseline (it would be non-null without the filter).
    expect((await f.forum.ingestion.freshness.get(a.storyId))?.topicBaselineMs).toBeNull();
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

  it('records an automated draft that passes quality + grounding', async () => {
    const f = fresh();
    const { threadId } = await seedThread(f.forum);
    await seedRoots(f, threadId, [
      'The city council approved the new budget on Tuesday.',
      'Some residents argue the budget favors downtown over the suburbs.',
      'Will the budget be revisited next quarter?',
    ]);
    const outcome = await generateThreadSummary(summaryDeps(f), threadId);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      // The §24.3 thread-summary Overview was removed, so a passing draft is no
      // longer published to a reader surface — it is recorded (AI draft store +
      // AIOutputRecord) for governance/audit only.
      expect(outcome.published).toBe(true);
      expect(await f.ai.summaries.getDraft(outcome.summaryId)).not.toBeNull();
    }
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
    // The summary must exist before it can be reported (no bogus-id pollution).
    await f.ai.summaries.putDraft({
      summaryId: 'sum-1',
      threadId: 'thread-1',
      draft: {},
      outputId: 'out-1',
      qualityPassed: true,
      createdAt: new Date(f.ai.now()).toISOString(),
    });
    await reportSummary(summaryDeps(f), 'sum-1', 'fake_citation', 'citation does not exist');
    const reports = await f.ai.summaries.listReports('sum-1');
    expect(reports[0]?.reason).toBe('fake_citation');
    const pending = await f.ai.reviewQueue.list({ kind: 'reported_summary' }, 10);
    expect(pending).toHaveLength(1);
  });

  it('N reports of ONE summary leave ONE pending queue item', async () => {
    // Both report routes are authenticated and were neither rate limited nor
    // deduplicated, so a single account could mint an unbounded number of
    // review-queue rows — and a steward queue in which one summary appears five
    // hundred times is how a real item goes unseen.  The reports themselves are
    // all still recorded; only the QUEUE is one-per-subject.
    const f = fresh();
    await f.ai.summaries.putDraft({
      summaryId: 'sum-flood',
      threadId: 'thread-1',
      draft: {},
      outputId: 'out-1',
      qualityPassed: true,
      createdAt: new Date(f.ai.now()).toISOString(),
    });
    for (let i = 0; i < 25; i += 1) {
      await reportSummary(summaryDeps(f), 'sum-flood', 'fake_citation', `report ${i}`);
    }
    expect(await f.ai.summaries.listReports('sum-flood')).toHaveLength(25);
    expect(await f.ai.reviewQueue.list({ kind: 'reported_summary' }, 100)).toHaveLength(1);
  });

  it('a RESOLVED item does not block a later re-report from opening a fresh one', async () => {
    // The index is partial on `pending` precisely so a steward decision can be
    // revisited: without that, one resolved item would silence a subject for good.
    const f = fresh();
    await f.ai.summaries.putDraft({
      summaryId: 'sum-again',
      threadId: 'thread-1',
      draft: {},
      outputId: 'out-1',
      qualityPassed: true,
      createdAt: new Date(f.ai.now()).toISOString(),
    });
    await reportSummary(summaryDeps(f), 'sum-again', 'fake_citation', null);
    const [pending] = await f.ai.reviewQueue.list({ kind: 'reported_summary' }, 10);
    if (!pending) throw new Error('no queue item');
    await f.ai.reviewQueue.resolve(
      pending.reviewId,
      'dismissed',
      'steward-1',
      new Date(f.ai.now()).toISOString(),
    );
    await reportSummary(summaryDeps(f), 'sum-again', 'fake_citation', null);
    expect(
      await f.ai.reviewQueue.list({ kind: 'reported_summary', status: 'pending' }, 10),
    ).toHaveLength(1);
    expect(await f.ai.reviewQueue.list({ kind: 'reported_summary' }, 10)).toHaveLength(2);
  });

  it('refuses a report for a non-existent summary (no bogus-id pollution)', async () => {
    const f = fresh();
    expect(await reportSummary(summaryDeps(f), 'nope', 'fake_citation', null)).toBeNull();
    expect(await f.ai.reviewQueue.list({ kind: 'reported_summary' }, 10)).toHaveLength(0);
  });

  // The PRODUCTION caller.  `generateThreadSummary` had none while
  // `reportSummary` — the same module — was routed, so a summary could be
  // reported and never generated.  These drive the scheduler task, not the
  // pipeline function, so removing the sweep fails here rather than leaving the
  // pipeline tests above green over an unreachable producer.
  describe('the hourly summary sweep (the production caller)', () => {
    function wired(): Fixture {
      const f = fresh();
      f.ai.ingestion = f.forum.ingestion;
      f.ai.forum = f.forum.forum;
      // The cursor lives in the fixture's own store, so each case already
      // starts from the newest page — no cross-test reset needed now that it
      // is not process-global.
      return f;
    }

    it('generates a draft for a thread the sweep reaches', async () => {
      const f = wired();
      const { threadId } = await seedThread(f.forum);
      await seedRoots(f, threadId, [
        'The city council approved the new budget on Tuesday.',
        'Some residents argue the budget favors downtown over the suburbs.',
        'Will the budget be revisited next quarter?',
      ]);
      const result = await runSummarySweep(f.ai);
      expect(result.generated).toBe(1);
      expect(await f.ai.summaries.getLatestForThread(threadId)).not.toBeNull();
    });

    it('summarizes a thread ONCE — a second tick mints no second record', async () => {
      const f = wired();
      const { threadId } = await seedThread(f.forum);
      await seedRoots(f, threadId, [
        'The city council approved the new budget on Tuesday.',
        'Some residents argue the budget favors downtown over the suburbs.',
        'Will the budget be revisited next quarter?',
      ]);
      const first = await runSummarySweep(f.ai);
      const draft = await f.ai.summaries.getLatestForThread(threadId);
      const second = await runSummarySweep(f.ai);
      expect(first.generated).toBe(1);
      // Re-summarizing hourly would mint an AIOutputRecord per thread per tick:
      // unbounded audit noise and unbounded guard work for no new signal.
      expect(second.generated).toBe(0);
      expect(second.skipped).toBe(1);
      expect((await f.ai.summaries.getLatestForThread(threadId))?.summaryId).toBe(draft?.summaryId);
    });

    it('a thread below the activity threshold is a skip, not a failure', async () => {
      const f = wired();
      const { threadId } = await seedThread(f.forum);
      await seedRoots(f, threadId, ['One comment only.']);
      const errors: string[] = [];
      const result = await runSummarySweep(f.ai, (_e, id) => errors.push(id));
      expect(result).toEqual({ examined: 1, generated: 0, skipped: 1 });
      expect(errors).toEqual([]);
    });

    it('one failing thread does not cost the rest of the page', async () => {
      const f = wired();
      const bad = await seedThread(f.forum);
      const good = await seedThread(f.forum);
      for (const id of [bad.threadId, good.threadId]) {
        await seedRoots(f, id, [
          'The city council approved the new budget on Tuesday.',
          'Some residents argue the budget favors downtown over the suburbs.',
          'Will the budget be revisited next quarter?',
        ]);
      }
      const realGet = f.ai.summaries.getLatestForThread.bind(f.ai.summaries);
      f.ai.summaries.getLatestForThread = async (threadId: string) => {
        if (threadId === bad.threadId) throw new Error('store outage');
        return realGet(threadId);
      };
      const failed: string[] = [];
      const result = await runSummarySweep(f.ai, (_e, id) => failed.push(id));
      // The next tick would start from the same page, so a thread that throws
      // must not be able to block every thread behind it forever.
      expect(failed).toEqual([bad.threadId]);
      expect(result.generated).toBe(1);
      expect(await f.ai.summaries.getLatestForThread(good.threadId)).not.toBeNull();
    });

    it('PAGES FORWARD — a second tick reaches threads the first never saw', async () => {
      // Reading the newest page every hour returns the same threads forever:
      // once they have drafts, or keep answering `insufficient_activity`, the
      // sweep never reaches an older one and any deployment with more threads
      // than the page size leaves the remainder permanently unsummarized.
      const f = wired();
      const ids: string[] = [];
      for (let i = 0; i < 4; i += 1) {
        const { threadId } = await seedThread(f.forum);
        ids.push(threadId);
        await seedRoots(f, threadId, [
          'The city council approved the new budget on Tuesday.',
          'Some residents argue the budget favors downtown over the suburbs.',
          'Will the budget be revisited next quarter?',
        ]);
      }
      // Two threads per tick over four threads: without a cursor the second
      // tick re-reads the same two and the older half is never summarized.
      const first = await runSummarySweep(f.ai, () => {}, 2);
      const second = await runSummarySweep(f.ai, () => {}, 2);
      expect(first.generated).toBe(2);
      expect(second.generated).toBe(2);
      // Every thread ended up with a draft — the property that matters.
      for (const id of ids) {
        expect(await f.ai.summaries.getLatestForThread(id)).not.toBeNull();
      }
    });

    it('SURVIVES the process that held the cursor (lease handover, restart)', async () => {
      // The tick runs under a distributed lease.  A cursor held in the process
      // is lost to every restart, deploy, and handover to another pod — each
      // one resetting the sweep to the newest page, so at one page an hour a
      // large installation is reset long before it reaches the tail and the
      // older threads it exists to summarize are never reached.
      const f = wired();
      const ids: string[] = [];
      for (let i = 0; i < 4; i += 1) {
        const { threadId } = await seedThread(f.forum);
        ids.push(threadId);
        await seedRoots(f, threadId, [
          'The city council approved the new budget on Tuesday.',
          'Some residents argue the budget favors downtown over the suburbs.',
          'Will the budget be revisited next quarter?',
        ]);
      }
      const first = await runSummarySweep(f.ai, () => {}, 2);
      expect(first.generated).toBe(2);
      // A DIFFERENT lease holder: fresh services over the SAME durable stores,
      // exactly as the next pod sees them.
      const next = {
        ...f.ai,
        sweepCursors: f.ai.sweepCursors,
      } as typeof f.ai;
      const stored = await f.ai.sweepCursors.get(SUMMARY_SWEEP_CURSOR);
      expect(stored).not.toBeNull();
      const second = await runSummarySweep(next, () => {}, 2);
      expect(second.generated).toBe(2);
      for (const id of ids) {
        expect(await f.ai.summaries.getLatestForThread(id)).not.toBeNull();
      }
    });

    it('COMMITS the cursor only after the page has been processed', async () => {
      // The cursor used to move before the loop, so a stop or crash between the
      // two — precisely the restart the persistence exists to survive — left the
      // next lease holder starting AFTER up to `limit` unexamined threads, which
      // are then unreachable until the corpus wraps back to the newest page.  A
      // cursor that can skip work is worse than one that repeats it: re-examining
      // costs one lookup, skipping costs a summary until the wrap.
      //
      // Process death cannot be staged in-process, so this asserts the property
      // that makes the crash safe: the write happens AFTER every thread on the
      // page has been examined.
      const f = wired();
      for (let i = 0; i < 3; i += 1) {
        const { threadId } = await seedThread(f.forum);
        await seedRoots(f, threadId, [
          'The city council approved the new budget on Tuesday.',
          'Some residents argue the budget favors downtown over the suburbs.',
          'Will the budget be revisited next quarter?',
        ]);
      }
      const order: string[] = [];
      const realGet = f.ai.summaries.getLatestForThread.bind(f.ai.summaries);
      vi.spyOn(f.ai.summaries, 'getLatestForThread').mockImplementation(async (id: string) => {
        order.push('examine');
        return realGet(id);
      });
      const realSet = f.ai.sweepCursors.set.bind(f.ai.sweepCursors);
      vi.spyOn(f.ai.sweepCursors, 'set').mockImplementation(async (name, cursor) => {
        order.push('commit');
        return realSet(name, cursor);
      });
      await runSummarySweep(f.ai, () => {}, 2);
      vi.restoreAllMocks();
      // Both threads on the page examined BEFORE the single commit.
      expect(order).toEqual(['examine', 'examine', 'commit']);
    });

    it('retries a TRANSIENT failure in-tick and still summarizes the thread', async () => {
      // Advancing the cursor past a failed thread costs a transient fault that
      // thread's summary until the whole corpus wraps — days on a large
      // installation.  The retry happens where the fault actually occurs.
      const f = wired();
      const { threadId } = await seedThread(f.forum);
      await seedRoots(f, threadId, [
        'The city council approved the new budget on Tuesday.',
        'Some residents argue the budget favors downtown over the suburbs.',
        'Will the budget be revisited next quarter?',
      ]);
      let calls = 0;
      const real = f.ai.summaries.getLatestForThread.bind(f.ai.summaries);
      const spy = vi
        .spyOn(f.ai.summaries, 'getLatestForThread')
        .mockImplementation(async (id: string) => {
          calls += 1;
          if (calls === 1) throw new Error('transient');
          return real(id);
        });
      const errors: string[] = [];
      const result = await runSummarySweep(f.ai, (_e, id) => errors.push(id), 2);
      spy.mockRestore();
      // The retry succeeded, so the thread got its summary and the caller heard
      // about no failure at all.
      expect(result.generated).toBe(1);
      expect(errors).toEqual([]);
      expect(await f.ai.summaries.getLatestForThread(threadId)).not.toBeNull();
    });

    it('a POISON thread does not pin the sweep — the cursor passes it', async () => {
      // The other half, and the opposite failure: holding the cursor until a
      // thread succeeds lets ONE permanently-broken thread (malformed stored
      // data, say) re-read the same page every tick for ever, so no older page
      // is ever reached again.  After its bounded attempts the sweep gives up,
      // reports it ONCE, and moves on.
      const f = wired();
      for (let i = 0; i < 4; i += 1) {
        const { threadId } = await seedThread(f.forum);
        await seedRoots(f, threadId, [
          'The city council approved the new budget on Tuesday.',
          'Some residents argue the budget favors downtown over the suburbs.',
          'Will the budget be revisited next quarter?',
        ]);
      }
      const spy = vi
        .spyOn(f.ai.summaries, 'getLatestForThread')
        .mockRejectedValue(new Error('poison'));
      const errors: string[] = [];
      await runSummarySweep(f.ai, (_e, id) => errors.push(id), 2);
      spy.mockRestore();
      // ONE report per thread, not one per attempt.
      expect(errors).toHaveLength(2);
      expect(new Set(errors).size).toBe(2);
      // …and the cursor MOVED, so the older pages stay reachable.
      const cursor = await f.ai.sweepCursors.get(SUMMARY_SWEEP_CURSOR);
      expect(cursor).not.toBeNull();
    });

    it('WRAPS to the newest page once the tail is exhausted', async () => {
      // A thread that only later crosses the activity threshold must still be
      // reachable, so the cursor resets rather than parking at the end.
      const f = wired();
      const { threadId } = await seedThread(f.forum);
      // A short page (limit 2) over one thread ⇒ the tail is reached at once.
      expect((await runSummarySweep(f.ai, () => {}, 2)).examined).toBe(1);
      await seedRoots(f, threadId, [
        'The city council approved the new budget on Tuesday.',
        'Some residents argue the budget favors downtown over the suburbs.',
        'Will the budget be revisited next quarter?',
      ]);
      expect((await runSummarySweep(f.ai, () => {}, 2)).generated).toBe(1);
    });

    it('WRAPS when the page comes back EMPTY, not just when it comes back short', async () => {
      // The trigger the short-page test above cannot reach: a page that is
      // exactly FULL, with nothing older behind it.  Four threads at limit 2
      // means tick 2 fills its page and lands the cursor on the oldest thread,
      // so tick 3 reads strictly older than that and gets nothing.
      //
      // An empty page IS the tail — the most unambiguous form of it — but the
      // commit guarded the wrap behind "did any thread settle", which an empty
      // page cannot satisfy.  The cursor stayed pinned at the oldest thread and
      // every later tick re-read the same empty page: `{examined: 0}` for ever,
      // with no metric and no error, so nothing created afterwards was ever
      // summarized again.  And the pinned position is the DURABLE row, so a
      // restart did not clear it either.
      const f = wired();
      for (let i = 0; i < 4; i += 1) {
        const { threadId } = await seedThread(f.forum);
        await seedRoots(f, threadId, [
          'The city council approved the new budget on Tuesday.',
          'Some residents argue the budget favors downtown over the suburbs.',
          'Will the budget be revisited next quarter?',
        ]);
      }
      expect((await runSummarySweep(f.ai, () => {}, 2)).examined).toBe(2);
      expect((await runSummarySweep(f.ai, () => {}, 2)).examined).toBe(2);
      // The tail tick: nothing older is left.
      expect((await runSummarySweep(f.ai, () => {}, 2)).examined).toBe(0);
      expect(await f.ai.sweepCursors.get(SUMMARY_SWEEP_CURSOR)).toBeNull();
      // The property that matters, and the one the parked cursor destroyed: a
      // thread created after the tail was reached still gets summarized.
      const { threadId: fresh } = await seedThread(f.forum);
      await seedRoots(f, fresh, [
        'The city council approved the new budget on Tuesday.',
        'Some residents argue the budget favors downtown over the suburbs.',
        'Will the budget be revisited next quarter?',
      ]);
      // Reached WITHIN a full traversal, not necessarily on the next tick: the
      // fixture clock is fixed, so all five threads share a `created_at` and the
      // DESC tiebreak falls to the random thread id — asserting the fresh thread
      // lands in the very first page after the wrap is a 2-in-5 coin flip.  What
      // the wrap actually guarantees is that it is reached at all, and three
      // pages of two cover five threads.
      for (let tick = 0; tick < 3; tick += 1) {
        if ((await f.ai.summaries.getLatestForThread(fresh)) !== null) break;
        await runSummarySweep(f.ai, () => {}, 2);
      }
      expect(await f.ai.summaries.getLatestForThread(fresh)).not.toBeNull();
    });

    it('a REPORTER that throws cannot cost the sweep its position', async () => {
      // `onThreadError` is caller-supplied.  It was invoked before the thread was
      // settled, so a logger that throws propagated out of the sweep ahead of the
      // commit — the cursor stayed put and the next tick re-read the same page,
      // the reporting path resurrecting the very livelock the attempt bound
      // exists to prevent.
      const f = wired();
      const ids: string[] = [];
      for (let i = 0; i < 2; i += 1) {
        const { threadId } = await seedThread(f.forum);
        ids.push(threadId);
        await seedRoots(f, threadId, [
          'The city council approved the new budget on Tuesday.',
          'Some residents argue the budget favors downtown over the suburbs.',
          'Will the budget be revisited next quarter?',
        ]);
      }
      // ASK which thread the first tick will read rather than assuming it.  The
      // fixture clock is fixed, so every thread shares a `created_at` and the
      // `(created_at, thread_id)` DESC order falls through to the id — which is
      // random per thread.  Picking "the last one seeded" made this test a coin
      // flip that passed alone and failed in the suite.
      const [first] = await f.forum.ingestion.stories.listThreads(null, 1);
      const poisoned = first?.threadId;
      expect(ids).toContain(poisoned);
      const realGetLatest = f.ai.summaries.getLatestForThread.bind(f.ai.summaries);
      f.ai.summaries.getLatestForThread = async (threadId: string) => {
        if (threadId === poisoned) throw new Error('poison');
        return realGetLatest(threadId);
      };
      await expect(
        runSummarySweep(
          f.ai,
          () => {
            throw new Error('the logger itself is broken');
          },
          1,
        ),
      ).resolves.toMatchObject({ examined: 1 });
      // The position moved past the poisoned thread despite the failed report,
      // so the second thread is reachable on the next tick.
      expect(await f.ai.sweepCursors.get(SUMMARY_SWEEP_CURSOR)).not.toBeNull();
      expect((await runSummarySweep(f.ai, () => {}, 1)).generated).toBe(1);
    });

    it('the sweep is BOUNDED — it never walks more threads than its limit', async () => {
      const f = wired();
      for (let i = 0; i < 4; i += 1) {
        const { threadId } = await seedThread(f.forum);
        await seedRoots(f, threadId, [
          'The city council approved the new budget on Tuesday.',
          'Some residents argue the budget favors downtown over the suburbs.',
          'Will the budget be revisited next quarter?',
        ]);
      }
      const result = await runSummarySweep(f.ai, () => {}, 2);
      expect(result.examined).toBe(2);
      expect(result.generated).toBe(2);
    });
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
    expect(report?.reason).toBe('mistranslation');
  });

  it('refuses a report for a non-existent translation (no bogus-id pollution)', async () => {
    const f = fresh();
    expect(await reportTranslation(translationDeps(f), 'nope', 'mistranslation')).toBeNull();
    expect(await f.ai.reviewQueue.list({ kind: 'reported_translation' }, 10)).toHaveLength(0);
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
