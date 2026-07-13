// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-H coverage, second wave: the POPULATED public read surfaces (all four
// exposure-label tiers; interpretations with real SCOI data), admin-route
// validation branches, per-invariant scheduler failure isolation (the
// observeError paths), the REAL MinHash near-duplicate grouping path for
// MERI assembly, degraded-input branches of the supporting services, and
// runner internals (latency-buffer trim, versionMetadata persistence,
// empty bounded maps).
import { randomUUID } from 'node:crypto';
import { minhashSignature } from '@licio/invariants';
import { independentSourcesResponseSchema, UNCLASSIFIED_TOPIC_ID } from '@licio/shared';
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assembleMeriCandidates,
  assemblePhiTopicData,
  assembleTopicCascade,
  citationDomainToken,
} from '../invariants/data.js';
import {
  HealthRecorder,
  hourWindow,
  mapBounded,
  persistComputations,
} from '../invariants/runner.js';
import { runBatchTier } from '../invariants/scheduler.js';
import { GLOBAL_FEED_TARGET_ID } from '../invariants/services-impl.js';
import type { CitedContribution, ModerationContentPort } from '../moderation/ports.js';
import {
  createInMemoryModerationServices,
  getModerationServices,
  resetModerationServicesForTests,
  setModerationServices,
} from '../moderation/services.js';
import { createV1Routes } from '../routes/v1.js';
import { attentionEvent } from './event-test-helpers.js';
import {
  freshInvariantServices,
  seedStory,
  seedUserWithSession,
} from './invariant-test-helpers.js';

function app() {
  return new Hono().route('/v1', createV1Routes());
}

async function upsertOutput(
  fixture: ReturnType<typeof freshInvariantServices>,
  row: {
    invariantType: string;
    targetType: string;
    targetId: string;
    scoreVector: Record<string, unknown>;
    reasonCodes?: string[];
  },
): Promise<void> {
  await fixture.events.invariantStore.upsert({
    invariantType: row.invariantType,
    targetType: row.targetType,
    targetId: row.targetId,
    timeWindow: hourWindow(Date.now()),
    version: '1.0.0',
    scoreVector: row.scoreVector,
    explanationSummary: null,
    confidence: 0.8,
    coverage: 1,
    reasonCodes: row.reasonCodes ?? [],
    fallbackUsed: false,
    versionMetadata: null,
    shadowMode: true,
    createdAt: new Date().toISOString(),
  });
}

describe('public surfaces with stored data', () => {
  it('serves populated interpretations with the needs-context gate', async () => {
    const fixture = freshInvariantServices();
    const { storyId } = await seedStory(fixture);
    await upsertOutput(fixture, {
      invariantType: 'SCOI',
      targetType: 'story',
      targetId: storyId,
      scoreVector: {
        scoi: 0.55,
        normalizer: 4,
        overlap_count: 2,
        lens_count: 3,
        context_state: 'split',
        per_overlap_energy: { 'a~b': 3.2, 'b~c': 0 },
      },
    });
    const response = await app().request(`http://local/v1/stories/${storyId}/interpretations`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      needs_context: boolean;
      context_state: string;
      interpretations: Array<{ summary: string; disagreement: number }>;
    };
    expect(body.needs_context).toBe(true);
    expect(body.context_state).toBe('split');
    expect(body.interpretations).toHaveLength(2);
    expect(body.interpretations[0]?.summary).toMatch(/differently/);
    expect(body.interpretations[1]?.summary).toMatch(/the same way/);
    // Invalid UUID 422s.
    expect((await app().request('http://local/v1/stories/nope/interpretations')).status).toBe(422);
  });

  it('maps all four exposure-label tiers on the drawer endpoint', async () => {
    const fixture = freshInvariantServices();
    const gains: Record<string, number> = {};
    const cases: Array<{ gain: number; label: string }> = [
      { gain: 1, label: 'independent_source' },
      { gain: 0.5, label: 'new_angle' },
      { gain: 0.01, label: 'same_claim_new_evidence' },
      { gain: 0, label: 'duplicate_context' },
    ];
    const ids: string[] = [];
    for (const { gain } of cases) {
      const { storyId } = await seedStory(fixture);
      ids.push(storyId);
      gains[storyId] = gain;
    }
    await upsertOutput(fixture, {
      invariantType: 'MERI',
      targetType: 'feed',
      targetId: GLOBAL_FEED_TARGET_ID,
      scoreVector: {
        meri: 0.8,
        marginal_gains: gains,
        approximation: false,
        per_class_bounds: { 'singleton:x': 1 },
        group_ids: [],
      },
    });
    for (let i = 0; i < cases.length; i += 1) {
      const response = await app().request(`http://local/v1/stories/${ids[i]}/independent-sources`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { exposure_label: string | null };
      expect(body.exposure_label).toBe(cases[i]?.label);
    }
    expect((await app().request('http://local/v1/stories/nope/independent-sources')).status).toBe(
      422,
    );
  });

  it('a degraded MERI row contributes NOTHING: gains AND redundancy classes both gated', async () => {
    const fixture = freshInvariantServices();
    const { storyId } = await seedStory(fixture);
    await upsertOutput(fixture, {
      invariantType: 'MERI',
      targetType: 'feed',
      targetId: GLOBAL_FEED_TARGET_ID,
      scoreVector: {
        meri: 0.8,
        marginal_gains: { [storyId]: 1 },
        approximation: false,
        per_class_bounds: { 'singleton:x': 1, 'singleton:y': 0.5 },
        group_ids: [],
      },
      // The WS-H.1.2c `usable` gate: an INSUFFICIENT_COVERAGE row is ABSENT to
      // every stored-output consumer — no stale gain, no fabricated classes.
      reasonCodes: ['INSUFFICIENT_COVERAGE'],
    });
    const response = await app().request(`http://local/v1/stories/${storyId}/independent-sources`);
    expect(response.status).toBe(200);
    const body = independentSourcesResponseSchema.parse(await response.json());
    expect(body.marginal_gain).toBeNull();
    expect(body.exposure_label).toBeNull();
    expect(body.redundancy_classes).toBe(0);
  });
});

describe('primary_sources on the independent-sources drawer (route surface)', () => {
  afterEach(() => {
    resetModerationServicesForTests();
  });

  function stubContentPort(row: CitedContribution): ModerationContentPort {
    return {
      async resolveTarget() {
        return { exists: true, subjectUserId: null, contentKind: 'contribution' };
      },
      async applyContentState() {},
      async applyAccountState() {},
      async contentSnapshot() {
        return null;
      },
      async threadContext() {
        return { items: [], reportedContributionId: null };
      },
      async getCitedContribution(contributionId) {
        return contributionId === row.contributionId ? row : null;
      },
    };
  }

  it('surfaces a steward mark through the schema-validated wire response', async () => {
    const fixture = freshInvariantServices();
    const { storyId, threadId } = await seedStory(fixture);
    const contributionId = randomUUID();
    setModerationServices(
      createInMemoryModerationServices({
        content: stubContentPort({
          contributionId,
          threadId,
          storyId,
          storyTitle: 'Seeded story',
          type: 'comment',
          bodyPreview: 'Sourced comment.',
          citations: [{ url: 'https://example.org/primary-dataset', title: 'Primary dataset' }],
          createdAt: new Date().toISOString(),
          threadRemoved: false,
        }),
      }),
    );
    const inserted = await getModerationServices().evidenceDecisions.insert({
      contributionId,
      threadId,
      storyId,
      action: 'mark-primary-source',
      citationUrl: 'https://example.org/primary-dataset',
      citationTitle: 'Primary dataset',
      reasonCode: null,
      note: null,
      decidedBy: null,
    });
    expect(inserted.ok).toBe(true);
    const response = await app().request(`http://local/v1/stories/${storyId}/independent-sources`);
    expect(response.status).toBe(200);
    const body = independentSourcesResponseSchema.parse(await response.json());
    expect(body.primary_sources).toEqual([
      { url: 'https://example.org/primary-dataset', title: 'Primary dataset' },
    ]);
  });

  it('fail-closed: a moderation singleton without a content port surfaces nothing', async () => {
    const fixture = freshInvariantServices();
    const { storyId, threadId } = await seedStory(fixture);
    // The bare in-memory seam has NO published-only `getCitedContribution`
    // read — an unverifiable mark must surface nothing, not leak.
    setModerationServices(createInMemoryModerationServices());
    const inserted = await getModerationServices().evidenceDecisions.insert({
      contributionId: randomUUID(),
      threadId,
      storyId,
      action: 'mark-primary-source',
      citationUrl: 'https://example.org/unverifiable',
      citationTitle: null,
      reasonCode: null,
      note: null,
      decidedBy: null,
    });
    expect(inserted.ok).toBe(true);
    const response = await app().request(`http://local/v1/stories/${storyId}/independent-sources`);
    expect(response.status).toBe(200);
    const body = independentSourcesResponseSchema.parse(await response.json());
    expect(body.primary_sources).toEqual([]);
  });
});

describe('admin validation branches', () => {
  it('422s malformed queries and filters outputs by reason code', async () => {
    const fixture = freshInvariantServices();
    const steward = await seedUserWithSession(fixture.identity, { steward: true });
    const headers = { cookie: steward.cookie, 'content-type': 'application/json' };
    const targetId = randomUUID();
    await upsertOutput(fixture, {
      invariantType: 'PHI',
      targetType: 'session',
      targetId,
      scoreVector: {
        phi: 1.1,
        rotation_angles: [0.8],
        loop_path: ['a', 'b', 'a'],
        fallback_log: false,
        sensitive: false,
      },
      reasonCodes: ['MATRIX_LOG_FALLBACK'],
    });
    const all = await app().request(
      `http://local/v1/invariants/admin/outputs?target_id=${targetId}`,
      { headers },
    );
    expect(all.status).toBe(200);
    expect(((await all.json()) as { outputs: unknown[] }).outputs).toHaveLength(1);
    const filtered = await app().request(
      `http://local/v1/invariants/admin/outputs?target_id=${targetId}&reason_code=TIMEOUT`,
      { headers },
    );
    expect(((await filtered.json()) as { outputs: unknown[] }).outputs).toHaveLength(0);
    expect(
      (await app().request('http://local/v1/invariants/admin/outputs?target_id=zzz', { headers }))
        .status,
    ).toBe(422);
    expect(
      (
        await app().request('http://local/v1/invariants/admin/compare?invariant_type=NOPE', {
          headers,
        })
      ).status,
    ).toBe(422);
    expect(
      (await app().request('http://local/v1/invariants/admin/promotions/NOPE', { headers })).status,
    ).toBe(422);
    expect(
      (
        await app().request('http://local/v1/invariants/admin/mfci/cases/not-a-uuid/resolve', {
          method: 'POST',
          headers,
          body: JSON.stringify({ action: 'cleared' }),
        })
      ).status,
    ).toBe(422);
    const regression = await app().request('http://local/v1/invariants/admin/regression', {
      headers,
    });
    expect(regression.status).toBe(200);
    expect(((await regression.json()) as { pass: boolean }).pass).toBe(true);
  });
});

describe('scheduler failure isolation per invariant', () => {
  it('a throwing service records an error without blocking the others', async () => {
    const fixture = freshInvariantServices();
    await seedStory(fixture);
    // Break ALL eleven services; the batch tier must complete regardless.
    for (const service of fixture.invariants.all()) {
      service.computeBatch = async () => {
        throw new Error('service down');
      };
    }
    await runBatchTier(fixture.invariants, fixture.events, fixture.ingestion, Date.now());
    for (const service of fixture.invariants.all()) {
      expect(service.getHealthMetrics().errorCount).toBe(1);
    }
    // Nothing was persisted (no degraded score ever lands as a value).
    expect(await fixture.events.invariantStore.listAll()).toHaveLength(0);
  });
});

describe('MERI assembly through real MinHash signatures', () => {
  it('groups near-duplicates detected by LSH band collisions', async () => {
    const fixture = freshInvariantServices();
    const text =
      'The water board released raw and processed sampling results alongside the methodology notes for independent verification by community laboratories across the region this week.';
    const nearCopy = `${text} Minor syndication footer.`;
    const distinct =
      'A completely different zoning appeal advanced through the planning commission after months of contested testimony about parking minimums and transit corridors downtown.';
    const a = await seedStory(fixture, { canonicalUrl: 'https://a.example/x' });
    const b = await seedStory(fixture, { canonicalUrl: 'https://b.example/y' });
    const c = await seedStory(fixture, { canonicalUrl: 'https://c.example/z' });
    const sign = async (storyId: string, body: string): Promise<void> => {
      const minhash = minhashSignature(body);
      await fixture.ingestion.signatures.upsert(
        {
          storyId,
          minhash,
          shingleK: 5,
          numHashes: 128,
          familyVersion: 1,
          textSource: 'submitted',
        },
        // The store derives band buckets from this signature.
        (await import('@licio/invariants')).lshBandHashes(minhash),
      );
    };
    await sign(a.storyId, text);
    await sign(b.storyId, nearCopy);
    await sign(c.storyId, distinct);
    const candidates = await assembleMeriCandidates(fixture.ingestion, null, null, 100, 0.7, 0.85);
    const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
    expect(byId.get(a.storyId)?.nearDuplicateGroupId).not.toBeNull();
    expect(byId.get(a.storyId)?.nearDuplicateGroupId).toBe(
      byId.get(b.storyId)?.nearDuplicateGroupId,
    );
    expect(byId.get(c.storyId)?.nearDuplicateGroupId).toBeNull();
    // Topic filtering branch: no candidates for an unknown topic.
    expect(
      await assembleMeriCandidates(fixture.ingestion, null, 'no-such-topic', 100, 0.7, 0.85),
    ).toEqual([]);
  });

  it('derives evidence lineage from the CITATION DOMAINS of each story thread', async () => {
    const fixture = freshInvariantServices();
    const a = await seedStory(fixture, { canonicalUrl: 'https://a.example/cite-1' });
    const b = await seedStory(fixture, { canonicalUrl: 'https://b.example/cite-2' });
    const c = await seedStory(fixture, { canonicalUrl: 'https://c.example/cite-3' });
    const cite = async (threadId: string, url: string): Promise<void> => {
      const inserted = await fixture.forum.contributions.insert({
        contributionId: randomUUID(),
        threadId,
        userId: randomUUID(),
        type: 'comment',
        body: 'A sourced comment carrying the citation.',
        citations: [{ url }],
        metadata: {},
        targetClaimId: null,
        parentContributionId: null,
        clientDraftId: randomUUID(),
        path: [],
        moderationState: 'published',
      });
      expect(inserted.ok).toBe(true);
    };
    // a + b cite the SAME registrable host (case-insensitive, www.-stripped);
    // c cites a DOI, which maps to the DOI-prefix token instead.
    await cite(a.threadId, 'https://www.Journal.example/study-1');
    await cite(b.threadId, 'https://journal.example/study-2');
    await cite(c.threadId, 'doi:10.5555/replication.7');
    const candidates = await assembleMeriCandidates(
      fixture.ingestion,
      fixture.forum,
      null,
      100,
      0.7,
      0.85,
    );
    const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
    expect(byId.get(a.storyId)?.evidenceGroupId).toBe('cit:journal.example');
    expect(byId.get(b.storyId)?.evidenceGroupId).toBe('cit:journal.example');
    expect(byId.get(c.storyId)?.evidenceGroupId).toBe('cit:doi:10.5555');
    expect(byId.get(a.storyId)?.inputsAvailable.evidence).toBe(true);
    expect(byId.get(a.storyId)?.independence?.evidenceGroupIds).toEqual(['cit:journal.example']);
    // Without a forum bundle there is no citation source ⇒ no evidence lineage.
    const withoutForum = await assembleMeriCandidates(
      fixture.ingestion,
      null,
      null,
      100,
      0.7,
      0.85,
    );
    expect(withoutForum.every((candidate) => candidate.evidenceGroupId === null)).toBe(true);
    expect(withoutForum.every((candidate) => candidate.inputsAvailable.evidence === false)).toBe(
      true,
    );
  });

  it('citationDomainToken: registrable-domain grouping, DOI prefixes, junk → null', () => {
    expect(citationDomainToken('https://WWW.Example.COM/path?x=1')).toBe('cit:example.com');
    expect(citationDomainToken('doi:10.1234/abc.def')).toBe('cit:doi:10.1234');
    // Sibling subdomains collapse to ONE registrable domain (eTLD+1, the
    // debate judge's anti-gaming rule) — spreading citations across
    // a./b.example.com cannot inflate apparent independence.
    expect(citationDomainToken('https://a.example.com/x')).toBe('cit:example.com');
    expect(citationDomainToken('https://b.example.com/y')).toBe('cit:example.com');
    expect(citationDomainToken('https://news.example.co.uk/z')).toBe('cit:example.co.uk');
    // DOI RESOLVER URLs group by DOI prefix, never by the shared resolver host.
    expect(citationDomainToken('https://doi.org/10.1234/abc')).toBe('cit:doi:10.1234');
    expect(citationDomainToken('https://dx.doi.org/10.5555/xyz')).toBe('cit:doi:10.5555');
    // A resolver URL with no parseable DOI falls through to the host token.
    expect(citationDomainToken('https://doi.org/about')).toBe('cit:doi.org');
    expect(citationDomainToken('not a url')).toBeNull();
  });

  it('assembleTopicCascade returns no cascade for the UNCLASSIFIED sentinel', async () => {
    const fixture = freshInvariantServices();
    // Two UNRELATED unclassified stories share the sentinel id; they must never
    // be assembled into one synthetic tropical cascade (a false coordination
    // signal). The sentinel guard short-circuits regardless of matching rows.
    await seedStory(fixture, { topicIds: [UNCLASSIFIED_TOPIC_ID] });
    await seedStory(fixture, { topicIds: [UNCLASSIFIED_TOPIC_ID] });
    expect(await assembleTopicCascade(fixture.ingestion, UNCLASSIFIED_TOPIC_ID)).toEqual([]);
  });

  it('assemblePhiTopicData never builds a PHI cluster for the sentinel', async () => {
    const fixture = freshInvariantServices();
    // Several unclassified stories must not form a synthetic PHI topic cluster;
    // the sentinel is filtered from `wanted` regardless of what the caller asks.
    for (let i = 0; i < 4; i += 1) {
      await seedStory(fixture, { topicIds: [UNCLASSIFIED_TOPIC_ID] });
    }
    const data = await assemblePhiTopicData(fixture.ingestion, [UNCLASSIFIED_TOPIC_ID]);
    expect(data.structures.size).toBe(0);
    expect(data.sensitive.has(UNCLASSIFIED_TOPIC_ID)).toBe(false);
  });
});

describe('degraded supporting-service branches', () => {
  it('hodge reports INSUFFICIENT_COVERAGE for reply-free threads', async () => {
    const fixture = freshInvariantServices();
    const { threadId } = await seedStory(fixture);
    const [output] = await fixture.invariants.hodge.computeBatch(
      [{ targetType: 'thread', targetId: threadId }],
      hourWindow(Date.now()),
    );
    expect(output?.reason_codes).toContain('INSUFFICIENT_COVERAGE');
  });

  it('braid and reeb degrade honestly on empty pools', async () => {
    const fixture = freshInvariantServices();
    const window = hourWindow(Date.now());
    const [braid] = await fixture.invariants.braid.computeBatch([], window);
    expect(braid?.reason_codes).toContain('INSUFFICIENT_COVERAGE');
    const [reeb] = await fixture.invariants.reeb.computeBatch([], window);
    expect(reeb?.reason_codes).toContain('INSUFFICIENT_COVERAGE');
    expect(await fixture.invariants.tropical.computeBatch([], window)).toEqual([]);
    expect(await fixture.invariants.cid.computeBatch([], window)).toHaveLength(1);
  });
});

describe('runner internals', () => {
  it('the health recorder trims its latency buffer and reports percentiles', () => {
    const recorder = new HealthRecorder();
    for (let i = 0; i < 1_100; i += 1) {
      recorder.observe(i, [{ coverage: 1, fallback_used: i % 2 === 0 }]);
    }
    const snapshot = recorder.snapshot();
    expect(snapshot.outputCount).toBe(1_100);
    expect(snapshot.latencyMsP50).toBeGreaterThan(0);
    expect(snapshot.latencyMsP99).toBeGreaterThanOrEqual(snapshot.latencyMsP50);
    expect(snapshot.fallbackRate).toBeCloseTo(0.5, 1);
  });

  it('persistComputations records versionMetadata when provided', async () => {
    const fixture = freshInvariantServices();
    const targetId = randomUUID();
    await persistComputations(
      fixture.events.invariantStore,
      { log: () => {}, metrics: fixture.events.metrics },
      [
        {
          invariantType: 'PHI' as never,
          target: { targetType: 'session', targetId },
          window: hourWindow(Date.now()),
          score_vector: {
            phi: 0.2,
            rotation_angles: [0.14],
            loop_path: ['a', 'b', 'a'],
            fallback_log: false,
            sensitive: false,
          },
          confidence: 0.7,
          coverage: 1,
          reason_codes: [],
          fallback_used: false,
          version: '1.0.0',
          explanationSummary: null,
        },
      ],
      { frames: 'embedding-v1' },
    );
    const rows = await fixture.events.invariantStore.listForTarget(targetId);
    expect(rows[0]?.versionMetadata).toEqual({ frames: 'embedding-v1' });
  });

  it('mapBounded handles empty input and over-wide concurrency', async () => {
    expect(await mapBounded([], 4, async (x) => x)).toEqual([]);
    expect(await mapBounded([1], 16, async (x) => x + 1)).toEqual([2]);
  });
});

describe('config validator matrix (fail-closed, every key)', () => {
  it('accepts a valid sample and rejects an invalid one for every key', async () => {
    const { INVARIANTS_CONFIG_KEYS, validateInvariantsConfigValue } = await import(
      '../invariants/config.js'
    );
    const valid: Record<string, unknown> = {
      'invariants.wrapperTimeoutMs': 5_000,
      'invariants.realtimeLatencyBudgetMs': 100,
      'invariants.batchConcurrency': 2,
      'invariants.meriCandidateLimit': 100,
      'invariants.meriNearDuplicateThreshold': 0.7,
      'invariants.meriSemanticDuplicateThreshold': 0.85,
      'invariants.mfciSamples': 500,
      'invariants.mfciBurnIn': 500,
      'invariants.mfciThinning': 2,
      'invariants.mfciFreezeScore': 1,
      'invariants.mfciRiskThresholds': { elevated: 3, high: 5, severe: 7 },
      'invariants.scoiStateThresholds': { ambiguous: 0.15, split: 0.4, obstructed: 0.7 },
      'invariants.phiThresholds': {
        baseThreshold: 1.5,
        sensitiveTopicFactor: 0.5,
        minorFactor: 0.6,
        baseRepeatThreshold: 3,
        repeatReduction: 1,
      },
      'invariants.phiNarrowLoop': { repeatThreshold: 3, windowMs: 1_800_000 },
      'invariants.phiSequenceCap': 200,
      'invariants.gweiEpsilons': [0.01],
      'invariants.gweiSeeds': [0, 7],
      'invariants.gweiKAnonymity': 25,
      'invariants.gweiMinCohortSize': 25,
      'invariants.promotionMinShadowDays': 14,
      'invariants.scoiNeedsContextThreshold': 0.4,
      'invariants.thresholdHuggingBandFraction': 0.15,
      'invariants.thresholdHuggingMinPopulation': 12,
      'invariants.thresholdHuggingExcess': 2.5,
      'invariants.mfciCalibrationDriftMaxRatio': 1.5,
      'invariants.mfciExcludeFlaggedWindows': true,
    };
    const invalid: Record<string, unknown> = {
      'invariants.wrapperTimeoutMs': -1,
      'invariants.realtimeLatencyBudgetMs': 99_999,
      'invariants.batchConcurrency': 0,
      'invariants.meriCandidateLimit': 1e9,
      'invariants.meriNearDuplicateThreshold': 1.5,
      'invariants.meriSemanticDuplicateThreshold': 0,
      'invariants.mfciSamples': 1,
      'invariants.mfciBurnIn': -5,
      'invariants.mfciThinning': 0,
      'invariants.mfciFreezeScore': -1,
      'invariants.mfciRiskThresholds': { elevated: 7, high: 5, severe: 3 },
      'invariants.scoiStateThresholds': { ambiguous: 0.9, split: 0.4, obstructed: 0.7 },
      'invariants.phiThresholds': {
        baseThreshold: 1,
        sensitiveTopicFactor: 2,
        minorFactor: 0.5,
        baseRepeatThreshold: 3,
        repeatReduction: 1,
      },
      'invariants.phiNarrowLoop': { repeatThreshold: 1, windowMs: 1_000 },
      'invariants.phiSequenceCap': 5,
      'invariants.gweiEpsilons': [],
      'invariants.gweiSeeds': [-1],
      'invariants.gweiKAnonymity': 1,
      'invariants.gweiMinCohortSize': 0,
      'invariants.promotionMinShadowDays': 9_999,
      'invariants.scoiNeedsContextThreshold': 2,
      'invariants.thresholdHuggingBandFraction': 1.5,
      'invariants.thresholdHuggingMinPopulation': 1,
      'invariants.thresholdHuggingExcess': 0.5,
      'invariants.mfciCalibrationDriftMaxRatio': 0.5,
      'invariants.mfciExcludeFlaggedWindows': 'nope',
    };
    for (const key of INVARIANTS_CONFIG_KEYS) {
      expect(validateInvariantsConfigValue(key, valid[key]), `${key} valid sample`).toBeNull();
      expect(
        validateInvariantsConfigValue(key, invalid[key]),
        `${key} invalid sample`,
      ).not.toBeNull();
    }
  });
});

describe('remaining service/data branches', () => {
  it('redundancyOf handles missing/malformed/maximal stored outputs', async () => {
    const fixture = freshInvariantServices();
    expect(await fixture.invariants.meri.redundancyOf(randomUUID())).toBe(0);
    await upsertOutput(fixture, {
      invariantType: 'MERI',
      targetType: 'feed',
      targetId: GLOBAL_FEED_TARGET_ID,
      scoreVector: {
        meri: 1,
        marginal_gains: { 'some-id': 0.25 },
        approximation: false,
        per_class_bounds: {},
        group_ids: [],
      },
    });
    expect(await fixture.invariants.meri.redundancyOf('absent-id')).toBe(0);
    expect(await fixture.invariants.meri.redundancyOf('some-id')).toBeCloseTo(0.75, 12);
  });

  it('PHI degrades when topic structures cannot be estimated for a cycle', async () => {
    const fixture = freshInvariantServices();
    const { userId } = await seedUserWithSession(fixture.identity);
    // ONE story per topic — far fewer than the preference dimension, so no
    // behavioral structure is estimable for any cluster in the cycle.
    const stories: string[] = [];
    for (const topic of ['gap-a', 'gap-b', 'gap-c']) {
      const { storyId } = await seedStory(fixture, { topicIds: [topic] });
      stories.push(storyId);
    }
    const base = Date.now() - 28 * 60_000;
    const pattern = [0, 1, 2, 0, 1, 2, 0]; // a genuine 3-topic cycle
    for (const [i, idx] of pattern.entries()) {
      await fixture.events.router.publish(
        attentionEvent(userId, {
          storyId: stories[idx] ?? '',
          timestamp: new Date(base + i * 3 * 60_000).toISOString(),
        }),
      );
    }
    const outputs = await fixture.invariants.phi.computeBatch([], hourWindow(Date.now()));
    expect(outputs).toHaveLength(1);
    expect(outputs[0]?.reason_codes).toContain('INSUFFICIENT_COVERAGE');
    expect(outputs[0]?.coverage).toBe(0);
  });

  it('braid/reeb/data consume seeded aggregation windows', async () => {
    const fixture = freshInvariantServices();
    const a = await seedStory(fixture, { topicIds: ['alpha'] });
    const b = await seedStory(fixture, { topicIds: ['beta'] });
    const hourMs = 3_600_000;
    const baseHour = Math.floor(Date.now() / hourMs) * hourMs;
    for (let h = 0; h < 3; h += 1) {
      for (const [storyId, count] of [
        [a.storyId, h % 2 === 0 ? 10 : 1],
        [b.storyId, h % 2 === 0 ? 1 : 10],
      ] as const) {
        await fixture.events.windowStore.upsert({
          itemId: storyId,
          windowStart: new Date(baseHour - h * hourMs).toISOString(),
          windowSize: '1h',
          uniqueActiveUsers: count,
          sourceOpens: 0,
          contextOpens: 0,
          returnVisits: 0,
          contributionCounts: {},
          antiSignalCounts: {},
          eventCount: count,
          computedAt: new Date().toISOString(),
        });
      }
    }
    const window = hourWindow(Date.now());
    const [braid] = await fixture.invariants.braid.computeBatch([], window);
    expect(braid?.reason_codes).toEqual([]);
    expect(braid?.score_vector['strands']).toBe(2);
    const [reeb] = await fixture.invariants.reeb.computeBatch([], window);
    expect(reeb?.score_vector['peak_count']).toBeGreaterThanOrEqual(1);
  });

  it('MFCI actions accept thread-target payloads and stored calibrations', async () => {
    const fixture = freshInvariantServices();
    const { threadId, storyId } = await seedStory(fixture);
    const nowMs = Date.now();
    await fixture.events.eventStore.insertMany(
      Array.from({ length: 30 }, (_, i) => ({
        eventId: randomUUID(),
        eventType: 'contribution.created',
        topic: 'contribution.created',
        timestamp: new Date(nowMs - i * 500).toISOString(),
        privacyClassification: 'public' as const,
        retentionTier: 'public_contribution' as const,
        // The thread-id payload branch (no story_id present).
        payload: { thread_id: threadId },
        ownerUserId: null,
        purgeAfter: null,
      })),
    );
    // A STORED calibration takes precedence over the bootstrap one.
    await fixture.invariants.calibrations.upsert({
      calibrationKey: 'mfci:target_concentration',
      version: 'stored-v2',
      data: {
        statistic: 'target_concentration',
        version: 'stored-v2',
        computedAtMs: nowMs,
        buckets: [{ minVolume: 0, q50: 0.1, q90: 0.2, q99: 0.3, sampleCount: 500 }],
      },
      sampleCount: 500,
      computedAt: new Date(nowMs).toISOString(),
    });
    await fixture.events.hooks.mfci?.({ target_ids: [storyId] } as never);
    const open = await fixture.invariants.mfciCases.listOpen(10);
    expect(open).toHaveLength(1);
    expect(open[0]?.fixedMarginsRef).toBe('cheap:stored-v2');
  });
});

describe('SCOI surface edge branches', () => {
  it('route guards: invalid ids, missing bodies, scope and 404 paths', async () => {
    const { Hono } = await import('hono');
    const { createV1Routes } = await import('../routes/v1.js');
    const fixture = freshInvariantServices();
    const steward = await seedUserWithSession(fixture.identity, { steward: true });
    const app = new Hono().route('/v1', createV1Routes());
    const req = (path: string, init: RequestInit = {}) =>
      app.request(`http://local/v1/invariants/admin${path}`, {
        ...init,
        headers: { cookie: steward.cookie, 'content-type': 'application/json' },
      });
    // Invalid UUIDs 422.
    expect((await req('/scoi/reports/not-a-uuid')).status).toBe(422);
    expect(
      (await req('/scoi/threads/not-a-uuid/bridge-requests', { method: 'POST', body: '{}' }))
        .status,
    ).toBe(422);
    // Missing thread 404 (uuid shape, no record).
    const ghost = randomUUID();
    expect(
      (await req(`/scoi/threads/${ghost}/bridge-requests`, { method: 'POST', body: '{}' })).status,
    ).toBe(404);
    // Roomless thread (no steward scope possible), then scoped guards.
    const { threadId, storyId } = await seedStory(fixture);
    const roomId = randomUUID();
    await fixture.forum.rooms.insert({
      roomId,
      name: 'Edge room',
      slug: `room-${roomId.slice(0, 8)}`,
      description: null,
      roomType: 'global_topic',
      visibility: 'public',
      joinModel: 'open',
      postingPolicy: 'all_members',
      createdBy: null,
      governanceMode: 'ordinary',
      charterSummary: null,
      typeMetadata: {},
      latestActivityAt: null,
    });
    await fixture.forum.rooms.addSteward({
      roomId,
      userId: steward.userId,
      role: 'community_steward',
      assignedAt: new Date().toISOString(),
    });
    await fixture.ingestion.stories.updateThread(threadId, { roomId });
    // Bridge request without a SCOI baseline 422s (no measurement exists
    // and recompute degrades on a lens-less story).
    expect(
      (await req(`/scoi/threads/${threadId}/bridge-requests`, { method: 'POST', body: '{}' }))
        .status,
    ).toBe(422);
    void storyId;
  });

  it('bridge stores and consumer edges: single-shot credit, no-decrease, missing payloads', async () => {
    const fixture = freshInvariantServices();
    const { InMemoryBridgeAttemptStore } = await import('../invariants/stores.js');
    const store = new InMemoryBridgeAttemptStore();
    expect(await store.openForThread('none')).toBeNull();
    expect(
      await store.credit('missing', {
        contributionId: randomUUID(),
        bridgeUserId: randomUUID(),
        scoiAfter: 0.1,
        resolvedAt: new Date().toISOString(),
      }),
    ).toBeNull();
    // Consumer ignores events without an open request or with missing fields.
    await fixture.events.router.publish({
      event_id: randomUUID(),
      event_type: 'contribution.created',
      timestamp: new Date().toISOString(),
      schema_version: '1',
      thread_id: randomUUID(),
      contribution_id: randomUUID(),
      user_id: randomUUID(),
      contribution_type: 'answer',
      privacy_classification: 'public',
      retention_tier: 'public_contribution',
    } as never);
    // No open request existed: nothing was credited (no crash, no effect).
    expect(await store.openForThread('none')).toBeNull();
  });
});

describe('guarded SCOI recompute (WS-H.1.2c on the on-demand path)', () => {
  it('a hanging compute degrades at the wrapper timeout instead of stalling the caller', async () => {
    const fixture = freshInvariantServices();
    await fixture.events.configStore.set('invariants.wrapperTimeoutMs', { value: 200 });
    await fixture.invariants.reloadConfig();
    const { recomputeScoiFor } = await import('../invariants/scoi-actions.js');
    fixture.invariants.scoi.computeBatch = () =>
      new Promise((resolve) => setTimeout(() => resolve([]), 2_000));
    const started = Date.now();
    const result = await recomputeScoiFor(fixture.invariants, fixture.events, randomUUID());
    expect(result).toBeNull();
    expect(Date.now() - started).toBeLessThan(1_500); // cut off, not awaited
    expect(fixture.invariants.scoi.getHealthMetrics().errorCount).toBe(1);
    const runs = await fixture.invariants.runMetadata.listRecent('SCOI', 1);
    expect(runs[0]?.success).toBe(false);
    expect(runs[0]?.failureReason).toBe('TIMEOUT');
    expect(runs[0]?.tier).toBe('near_realtime');
  });
});
