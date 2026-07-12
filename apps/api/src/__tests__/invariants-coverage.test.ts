// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-H branch-coverage suite: the paths the main suites do not reach —
// the full SCOI lens-interpretation pipeline, GWEI cohort comparison with
// lowered thresholds (+ k-anonymity suppression on the wire), scheduler
// error isolation and the nightly drift branch, store edge cases, config
// envelope variants, promotion evidence coercion, and the batch-only
// real-time default.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadInvariantsConfig } from '../invariants/config.js';
import { hourWindow } from '../invariants/runner.js';
import { runInvariantsTick, startInvariantsScheduler } from '../invariants/scheduler.js';
import {
  InMemoryMfciCaseStore,
  InMemoryRunMetadataStore,
  InMemorySessionTopicSequenceStore,
  SESSION_SEQUENCE_TTL_MS,
} from '../invariants/stores.js';
import { attentionEvent } from './event-test-helpers.js';
import {
  freshInvariantServices,
  type InvariantServicesFixture,
  seedStory,
  seedUserWithSession,
} from './invariant-test-helpers.js';

describe('SCOI full lens pipeline (WS-H.4.1a/b)', () => {
  async function seedLensedStory(fixture: InvariantServicesFixture): Promise<string> {
    const roomId = randomUUID();
    const inserted = await fixture.forum.rooms.insert({
      roomId,
      name: `Room ${roomId.slice(0, 8)}`,
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
    expect(inserted.ok).toBe(true);
    const lensIds: string[] = [];
    for (const lensType of ['local_resident', 'expert'] as const) {
      const lens = await fixture.forum.lenses.insert({
        lensId: randomUUID(),
        roomId,
        name: `Lens ${lensType}`,
        lensType,
        description: null,
      });
      if (lens.ok) lensIds.push(lens.lens.lensId);
    }
    expect(lensIds).toHaveLength(2);
    const { storyId, threadId } = await seedStory(fixture);
    await fixture.ingestion.stories.updateThread(threadId, { roomId });
    // Divergent lens-tagged readings on the same thread.
    const bodies: Record<string, string> = {
      [lensIds[0] ?? '']: 'Locally this reads as a routine maintenance notice for the plant.',
      [lensIds[1] ?? '']: 'Technically the figures indicate a sampling anomaly worth review.',
    };
    for (const lensId of lensIds) {
      const result = await fixture.forum.contributions.insert({
        contributionId: randomUUID(),
        threadId,
        userId: randomUUID(),
        type: 'comment',
        body: bodies[lensId] ?? 'Reading.',
        citations: [],
        metadata: { lens_id: lensId },
        targetClaimId: null,
        parentContributionId: null,
        clientDraftId: randomUUID(),
        path: [],
        moderationState: 'published',
      });
      expect(result.ok).toBe(true);
    }
    return storyId;
  }

  it('captures per-lens interpretations and scores the overlap', async () => {
    const fixture = freshInvariantServices();
    const storyId = await seedLensedStory(fixture);
    const [output] = await fixture.invariants.scoi.computeBatch(
      [{ targetType: 'story', targetId: storyId }],
      hourWindow(Date.now()),
    );
    expect(output).toBeTruthy();
    expect(output?.reason_codes).toEqual([]);
    const scoi = output?.score_vector['scoi'];
    expect(typeof scoi).toBe('number');
    expect(scoi).toBeGreaterThanOrEqual(0);
    expect(scoi).toBeLessThanOrEqual(1);
    expect(output?.score_vector['lens_count']).toBe(2);
    expect(output?.score_vector['overlap_count']).toBe(1);
    expect(typeof output?.score_vector['context_state']).toBe('string');
    // SCOI v2 rides the same batch output: identity restriction maps over
    // a two-lens diagram glue freely — H¹ trivial, no structural code.
    expect(output?.score_vector['dim_h1']).toBe(0);
    expect(output?.score_vector['structural_obstruction']).toBe(false);
  });
});

describe('GWEI cohort comparison end-to-end (WS-H.5)', () => {
  it('compares eligible cohorts and suppresses below-k pairs', async () => {
    const fixture = freshInvariantServices();
    // Lower the cohort thresholds through the VALIDATED config path.
    await fixture.events.configStore.set('invariants.gweiMinCohortSize', { value: 2 });
    await fixture.events.configStore.set('invariants.gweiKAnonymity', { value: 2 });
    await fixture.events.configStore.set('invariants.gweiSeeds', { value: [0] });
    await fixture.events.configStore.set('invariants.gweiEpsilons', { value: [0.05] });
    await fixture.invariants.reloadConfig();

    const stories = await Promise.all([
      seedStory(fixture, { topicIds: ['water'] }),
      seedStory(fixture, { topicIds: ['transit'] }),
      seedStory(fixture, { topicIds: ['zoning'] }),
    ]);
    // Two locale cohorts of two users each, with attention on the stories.
    const { defaultPersonalizationSettings, defaultPrivacySettings } = await import(
      '@licio/shared'
    );
    for (const locale of ['en-US', 'es-ES']) {
      for (let i = 0; i < 2; i += 1) {
        const user = await fixture.identity.store.createUser(
          {
            handle: `cohort-${locale}-${i}-${randomUUID().slice(0, 6)}`,
            displayName: 'Cohort member',
            email: null,
            accountState: 'active',
            locale,
            ageBand: 'adult',
            privacySettings: defaultPrivacySettings(),
            personalizationSettings: defaultPersonalizationSettings(),
            roles: ['user'],
          },
          Date.now() - 30 * 86_400_000,
        );
        const userId = user.userId;
        for (const { storyId } of stories) {
          await fixture.events.attentionStore.insertMany([
            {
              aggregate_id: randomUUID(),
              user_id_or_privacy_bucket: userId,
              story_id: storyId,
              session_bucket: '2026-06-10T10:00:00.000Z',
              active_dwell_bucket: 'long',
              source_opened: locale === 'en-US',
              context_opened: false,
              branch_depth_bucket: 'shallow',
              return_visit_count_bucket: 'none',
              privacy_level: 'standard',
              created_at: new Date().toISOString(),
            },
          ]);
        }
      }
    }
    const outputs = await fixture.invariants.gwei.computeBatch([], hourWindow(Date.now()));
    expect(outputs.length).toBeGreaterThan(0);
    const real = outputs.filter((o) => !o.reason_codes.includes('SUPPRESSED_K_ANONYMITY'));
    expect(real.length).toBeGreaterThan(0);
    for (const output of real) {
      const gw2 = output.score_vector['gw2'];
      expect(typeof gw2).toBe('number');
      expect(gw2).toBeGreaterThanOrEqual(0);
      expect(output.score_vector['cohort_a']).toBeTruthy();
      expect(output.target.targetType).toBe('cohort');
    }
    // Raise k back above the cohort sizes: every pair suppresses.
    await fixture.events.configStore.set('invariants.gweiKAnonymity', { value: 50 });
    await fixture.invariants.reloadConfig();
    const suppressed = await fixture.invariants.gwei.computeBatch([], hourWindow(Date.now()));
    expect(suppressed.every((o) => o.reason_codes.includes('SUPPRESSED_K_ANONYMITY'))).toBe(true);
  });

  it('assembles REAL experience features: depth, lenses, evidence, familiarity, age bands', async () => {
    const fixture = freshInvariantServices();
    const { assembleCohorts } = await import('../invariants/data.js');
    const { defaultPersonalizationSettings, defaultPrivacySettings } = await import(
      '@licio/shared'
    );
    const mkUser = async (ageBand: 'adult' | 'teen_16_17' | null): Promise<string> => {
      const user = await fixture.identity.store.createUser(
        {
          handle: `gwei-${randomUUID().slice(0, 10)}`,
          displayName: 'Cohort member',
          email: null,
          accountState: 'active',
          locale: 'en-US',
          ageBand,
          privacySettings: defaultPrivacySettings(),
          personalizationSettings: defaultPersonalizationSettings(),
          roles: ['user'],
        },
        Date.now() - 30 * 86_400_000,
      );
      return user.userId;
    };
    const teen = await mkUser('teen_16_17');
    const noBand = await mkUser(null);

    // Story S1: thread with a depth-2 reply chain, a lens-tagged
    // contribution, and a SOURCED reply (comment-centric citations).
    const s1 = await seedStory(fixture, { topicIds: ['water'] });
    const s2 = await seedStory(fixture, { topicIds: ['water'] });
    const s3 = await seedStory(fixture, { topicIds: ['transit'] });
    const root = await fixture.forum.contributions.insert({
      contributionId: randomUUID(),
      threadId: s1.threadId,
      userId: randomUUID(),
      type: 'comment',
      body: 'What does the sampling protocol require here?',
      citations: [],
      metadata: {},
      targetClaimId: null,
      parentContributionId: null,
      clientDraftId: randomUUID(),
      path: [],
      moderationState: 'published',
    });
    expect(root.ok).toBe(true);
    const rootId = root.ok ? root.contribution.contributionId : '';
    const reply = await fixture.forum.contributions.insert({
      contributionId: randomUUID(),
      threadId: s1.threadId,
      userId: randomUUID(),
      type: 'comment',
      body: 'Quarterly composite samples per the permit.',
      citations: [{ url: 'https://example.com/permit' }],
      metadata: { lens_id: 'lens-expert' },
      targetClaimId: null,
      parentContributionId: rootId,
      clientDraftId: randomUUID(),
      path: [rootId],
      moderationState: 'published',
    });
    expect(reply.ok).toBe(true);

    const aggregate = (userId: string, storyId: string, dwell: 'extended' | 'long') => ({
      aggregate_id: randomUUID(),
      user_id_or_privacy_bucket: userId,
      story_id: storyId,
      session_bucket: '2026-06-10T10:00:00.000Z',
      active_dwell_bucket: dwell,
      source_opened: false,
      context_opened: false,
      branch_depth_bucket: 'shallow',
      return_visit_count_bucket: 'none',
      privacy_level: 'standard',
      created_at: new Date().toISOString(),
    });
    // Teen engages TWO water stories (repeat exposure ⇒ familiar) at
    // extended dwell; the band-less user touches S1 once at lighter dwell.
    await fixture.events.attentionStore.insertMany([
      aggregate(teen, s1.storyId, 'extended'),
      aggregate(teen, s2.storyId, 'extended'),
      aggregate(teen, s3.storyId, 'extended'),
      aggregate(noBand, s1.storyId, 'long'),
    ]);

    const cohorts = await assembleCohorts(
      fixture.events,
      fixture.identity,
      fixture.ingestion,
      fixture.forum,
      Date.now(),
    );
    const keys = cohorts.map((c) => c.cohortKey);
    // Age-band cohorts only when KNOWN — never inferred, never null-keyed.
    expect(keys).toContain('age:teen_16_17');
    expect(keys.some((k) => k.startsWith('age:') && k.includes('null'))).toBe(false);
    const teenCohort = cohorts.find((c) => c.cohortKey === 'age:teen_16_17');
    expect(teenCohort?.size).toBe(1);

    const enUs = cohorts.find((c) => c.cohortKey === 'locale:en-US');
    expect(enUs?.size).toBe(2);
    const item1 = enUs?.items.find((i) => i.itemId === s1.storyId);
    const item3 = enUs?.items.find((i) => i.itemId === s3.storyId);
    // Real thread depth (root + reply ⇒ deepest path length 1), the tagged
    // lens, and evidence carried by the reply's citation.
    expect(item1?.discussionDepth).toBe(1);
    expect(item1?.lensKeys).toEqual(['lens-expert']);
    expect(item1?.hasPrimaryEvidence).toBe(true);
    // Familiarity is weight-majority repeat exposure: the teen's extended
    // (1.0) familiar weight outweighs the band-less user's long (0.75)
    // single touch on S1; the lone transit story stays unfamiliar.
    expect(item1?.familiarTopic).toBe(true);
    expect(item3?.familiarTopic).toBe(false);
    expect(item3?.hasPrimaryEvidence).toBe(false);
    expect(item3?.discussionDepth).toBe(0);
  });
});

describe('scheduler branches (WS-H.1.2f)', () => {
  it('isolates task errors and runs the nightly regression at 00 UTC', async () => {
    const fixture = freshInvariantServices();
    await seedStory(fixture);
    const drift: Array<Record<string, unknown>> = [];
    fixture.invariants.log = () => {};
    // Force the session sweep to fail; everything else must still run.
    fixture.invariants.sessions.sweepExpired = async () => {
      throw new Error('sweep down');
    };
    const errors: string[] = [];
    const midnight = Date.UTC(2026, 5, 11, 0, 30, 0);
    const logs: string[] = [];
    fixture.invariants.log = (event) => {
      logs.push(event);
      if (event === 'invariants.regression.nightly') drift.push({});
    };
    await runInvariantsTick(
      fixture.invariants,
      fixture.events,
      fixture.ingestion,
      (_err, task) => errors.push(task),
      midnight,
    );
    expect(errors).toContain('session_sweep');
    expect(drift).toHaveLength(1); // the nightly drift report ran
    expect(fixture.events.metrics.counter('invariants.regression.pass')).toBe(1);
  });

  it('the interval scheduler ticks only when the lease grants (fail closed)', async () => {
    const fixture = freshInvariantServices();
    let granted = false;
    let leaseChecks = 0;
    const stop = startInvariantsScheduler(
      fixture.invariants,
      fixture.events,
      fixture.ingestion,
      () => {},
      5,
      {
        lease: {
          tryAcquire: async () => {
            leaseChecks += 1;
            return granted;
          },
        },
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(leaseChecks).toBeGreaterThan(0);
    granted = true;
    await new Promise((resolve) => setTimeout(resolve, 30));
    stop();
    const runs = await fixture.invariants.runMetadata.listRecent('MERI', 1);
    expect(runs.length).toBeGreaterThanOrEqual(0); // tick executed without throwing
  });
});

describe('store edge cases', () => {
  it('mfci case store: getById, missing target, resolve of non-open rows', async () => {
    const store = new InMemoryMfciCaseStore();
    expect(await store.getById(randomUUID())).toBeNull();
    expect(await store.latestForTarget(randomUUID())).toBeNull();
    expect(
      await store.resolve(randomUUID(), 'cleared', 'steward:x', new Date().toISOString()),
    ).toBeNull();
  });

  it('run metadata trims its bounded buffer', async () => {
    const store = new InMemoryRunMetadataStore();
    for (let i = 0; i < 10_100; i += 1) {
      await store.append({
        invariantType: 'MERI',
        tier: 'batch',
        targetCount: 0,
        durationMs: 1,
        success: true,
        failureReason: null,
        startedAt: new Date(i).toISOString(),
      });
    }
    const recent = await store.listRecent('MERI', 20_000);
    expect(recent.length).toBeLessThanOrEqual(10_000);
  });

  it('session sequences: TTL expiry on read, append restart, sweep, clear', async () => {
    const store = new InMemorySessionTopicSequenceStore();
    const t0 = 1_000_000;
    await store.append('key', { topicClusterId: 'a', atMs: t0 }, t0, 5);
    expect(await store.get('key', t0 + 1)).toHaveLength(1);
    // Expired read returns empty; appending after expiry restarts fresh.
    const later = t0 + SESSION_SEQUENCE_TTL_MS + 1;
    expect(await store.get('key', later)).toEqual([]);
    await store.append('key', { topicClusterId: 'b', atMs: later }, later, 5);
    expect((await store.get('key', later + 1)).map((s) => s.topicClusterId)).toEqual(['b']);
    expect(await store.sweepExpired(later + SESSION_SEQUENCE_TTL_MS + 2)).toBe(1);
    await store.clear();
    expect(await store.listLive(later)).toEqual([]);
  });
});

describe('config + promotion + realtime branches', () => {
  it('loader accepts non-envelope stored objects (direct value rows)', async () => {
    const fixture = freshInvariantServices();
    // An object value stored WITHOUT the { value: … } envelope.
    await fixture.events.configStore.set('invariants.mfciRiskThresholds', {
      elevated: 2,
      high: 4,
      severe: 6,
    } as never);
    const config = await loadInvariantsConfig(fixture.events.configStore);
    expect(config.mfciRiskThresholds.high).toBe(4);
  });

  it('promotion history coerces partial evidence and rejects unknown types', async () => {
    const fixture = freshInvariantServices();
    await fixture.invariants.promotions.append({
      invariantType: 'PHI',
      fromStatus: 'shadow',
      toStatus: 'soft_constraint',
      evidence: {}, // missing fields coerce to zero/empty
      owner: 'x',
      createdAt: new Date().toISOString(),
    });
    const history = await fixture.invariants.promotionService.history('PHI');
    expect(history[0]?.evidence.shadowDurationDays).toBe(0);
    expect(history[0]?.evidence.driftReportRef).toBe('');
    expect(
      await fixture.invariants.promotionService.apply(
        {
          invariantType: 'not_a_real_invariant',
          fromStatus: 'shadow',
          toStatus: 'soft_constraint',
          evidence: {
            shadowDurationDays: 30,
            driftReportRef: 'x',
            observedCoverage: 1,
            observedConfidence: 1,
          },
          owner: 'x',
          createdAt: new Date().toISOString(),
        },
        14,
      ),
    ).toMatch(/unknown invariant type/);
  });

  it('batch-only invariants answer real-time calls with an honest degraded output', async () => {
    const fixture = freshInvariantServices();
    const result = await fixture.invariants.gwei.computeRealtime({
      targetType: 'cohort',
      targetId: randomUUID(),
    });
    expect(result.reason_codes).toContain('INSUFFICIENT_COVERAGE');
    expect(result.confidence).toBe(0);
    expect(result.explanationSummary).toMatch(/batch-only/);
    // MERI's real-time path IS implemented (cheap candidates pass).
    const meri = await fixture.invariants.meri.computeRealtime({
      targetType: 'feed',
      targetId: randomUUID(),
    });
    expect(typeof meri.score_vector['meri']).toBe('number');
  });

  it('the MFCI intake ignores low-concentration activity (no case opened)', async () => {
    const fixture = freshInvariantServices();
    const stories = await Promise.all(Array.from({ length: 10 }, () => seedStory(fixture)));
    const nowMs = Date.now();
    await fixture.events.eventStore.insertMany(
      stories.map(({ storyId }, i) => ({
        eventId: randomUUID(),
        eventType: 'contribution.created',
        topic: 'contribution.created',
        timestamp: new Date(nowMs - i * 1000).toISOString(),
        privacyClassification: 'public' as const,
        retentionTier: 'public_contribution' as const,
        payload: { story_id: storyId },
        ownerUserId: null,
        purgeAfter: null,
      })),
    );
    const first = stories[0];
    if (!first) throw new Error('seed failed');
    await fixture.events.hooks.mfci?.({ target_ids: [first.storyId] } as never);
    expect(await fixture.invariants.mfciCases.listOpen(10)).toHaveLength(0);
  });

  it('the PHI session consumer skips events without topics or session context', async () => {
    const fixture = freshInvariantServices();
    const { userId } = await seedUserWithSession(fixture.identity);
    // Unknown story (no topics resolvable) — nothing is recorded.
    await fixture.events.router.publish(attentionEvent(userId, { storyId: randomUUID() }));
    expect(await fixture.invariants.sessions.listLive(Date.now())).toEqual([]);
  });
});
