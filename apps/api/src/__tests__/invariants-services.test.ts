// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-H service tests against the real in-memory WS-D/E/F/G stores:
// MERI assembly + computation over seeded duplicate/lineage structures,
// MFCI batch fiber test + the cheap-statistic intake consumer + the case
// lifecycle with freeze clearing, SCOI lens-interpretation capture, the PHI
// session consumer (privacy assertions) + loop detection + batch holonomy,
// the path-signature classifier on session sequences, supporting services
// on seeded data, and the WS-E hook closures (redundancy, mfci).
import { randomUUID } from 'node:crypto';
import type { SensitivityLabel } from '@licio/shared';
import { describe, expect, it, vi } from 'vitest';
import { assembleMeriCandidates, sessionEventsFromSequence } from '../invariants/data.js';
import { hourWindow } from '../invariants/runner.js';
import { GLOBAL_FEED_TARGET_ID } from '../invariants/services-impl.js';
import { attentionEvent } from './event-test-helpers.js';
import {
  freshInvariantServices,
  type InvariantServicesFixture,
  seedStory,
  seedUserWithSession,
} from './invariant-test-helpers.js';

async function seedSyndicatedPair(fixture: InvariantServicesFixture): Promise<{
  originalId: string;
  copyId: string;
  freshId: string;
}> {
  const wire = await fixture.ingestion.sources.upsertByDomain('wire.example', { name: 'Wire' });
  const mirror = await fixture.ingestion.sources.upsertByDomain('mirror.example', {
    name: 'Mirror',
  });
  const edge = await fixture.ingestion.syndications.insert({
    syndicationId: randomUUID(),
    fromSourceId: wire.sourceId,
    toSourceId: mirror.sourceId,
    relationshipType: 'wire',
    establishedBy: 'steward',
    status: 'confirmed',
    evidenceRef: 'steward:confirmed',
    confidence: 1,
  });
  expect(edge.ok).toBe(true);
  const { storyId: originalId } = await seedStory(fixture, {
    canonicalUrl: 'https://wire.example/report',
    sourceId: wire.sourceId,
    title: 'Original wire report',
  });
  const { storyId: copyId } = await seedStory(fixture, {
    canonicalUrl: 'https://mirror.example/report',
    sourceId: mirror.sourceId,
    title: 'Mirrored wire report',
  });
  const { storyId: freshId } = await seedStory(fixture, {
    canonicalUrl: 'https://independent.example/analysis',
    title: 'Independent analysis',
  });
  return { originalId, copyId, freshId };
}

describe('MERI service (WS-H.2)', () => {
  it('groups syndicated lineage and scores the pool below 1', async () => {
    const fixture = freshInvariantServices();
    const { originalId, copyId, freshId } = await seedSyndicatedPair(fixture);
    const candidates = await assembleMeriCandidates(fixture.ingestion, null, null, 100, 0.7, 0.85);
    const byId = new Map(candidates.map((c) => [c.id, c]));
    // Confirmed syndication joins the two sources into one lineage group.
    expect(byId.get(originalId)?.sourceLineageGroupId).not.toBeNull();
    expect(byId.get(originalId)?.sourceLineageGroupId).toBe(byId.get(copyId)?.sourceLineageGroupId);
    expect(byId.get(freshId)?.sourceLineageGroupId).toBeNull();

    const window = hourWindow(Date.now());
    const target = { targetType: 'feed' as const, targetId: GLOBAL_FEED_TARGET_ID };
    const [output] = await fixture.invariants.meri.computeBatch([target], window);
    expect(output).toBeTruthy();
    const meri = output?.score_vector['meri'];
    expect(typeof meri).toBe('number');
    // Three stories, lineage bound 2 ⇒ everything still independent enough,
    // but the marginal-gain map carries every candidate.
    const gains = output?.score_vector['marginal_gains'] as Record<string, number>;
    expect(Object.keys(gains).sort()).toEqual([originalId, copyId, freshId].sort());
  });

  it('closes the WS-E redundancy hook from the latest MERI output', async () => {
    const fixture = freshInvariantServices();
    const { copyId } = await seedSyndicatedPair(fixture);
    const window = hourWindow(Date.now());
    const target = { targetType: 'feed' as const, targetId: GLOBAL_FEED_TARGET_ID };
    const outputs = await fixture.invariants.meri.computeBatch([target], window);
    const first = outputs[0];
    if (!first) throw new Error('no MERI output');
    await fixture.events.invariantStore.upsert({
      invariantType: 'MERI',
      targetType: 'feed',
      targetId: GLOBAL_FEED_TARGET_ID,
      timeWindow: window,
      version: first.version,
      scoreVector: first.score_vector,
      explanationSummary: null,
      confidence: first.confidence,
      coverage: first.coverage,
      reasonCodes: first.reason_codes,
      fallbackUsed: first.fallback_used,
      versionMetadata: null,
      shadowMode: true,
      createdAt: new Date().toISOString(),
    });
    // The hook is synchronous + cached: first call warms, second serves.
    const hook = fixture.events.hooks.redundancy;
    expect(hook).toBeTruthy();
    hook?.(copyId);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const redundancy = hook?.(copyId) ?? -1;
    expect(redundancy).toBeGreaterThanOrEqual(0);
    expect(redundancy).toBeLessThanOrEqual(1);
  });
});

describe('MFCI service (WS-H.3)', () => {
  it('cheap-statistic intake opens a case on concentrated reporting and clearing lifts it', async () => {
    const fixture = freshInvariantServices();
    const { storyId, threadId } = await seedStory(fixture, {
      canonicalUrl: 'https://example.org/target',
    });
    void threadId;
    // 30 distinct accounts pile onto ONE target within minutes.
    const nowMs = Date.now();
    const rows = Array.from({ length: 30 }, (_, i) => ({
      eventId: randomUUID(),
      eventType: 'contribution.created',
      topic: 'contribution.created',
      timestamp: new Date(nowMs - i * 1000).toISOString(),
      privacyClassification: 'public' as const,
      retentionTier: 'public_contribution' as const,
      payload: { story_id: storyId },
      ownerUserId: null,
      purgeAfter: null,
    }));
    await fixture.events.eventStore.insertMany(rows);
    await fixture.events.hooks.mfci?.({
      event_id: randomUUID(),
      event_type: 'integrity.signal.detected',
      timestamp: new Date(nowMs).toISOString(),
      schema_version: '1',
      signal_type: 'coordinated_burst',
      target_ids: [storyId],
      confidence: 0.9,
      window_start: new Date(nowMs - 3_600_000).toISOString(),
      window_size: '1h',
      evidence_summary: 'burst',
      privacy_classification: 'sensitive',
      retention_tier: 'moderation_legal',
    } as never);
    const open = await fixture.invariants.mfciCases.listOpen(10);
    expect(open).toHaveLength(1);
    expect(open[0]?.targetId).toBe(storyId);
    expect(open[0]?.riskState).toBe('high');
    // The case carries identifier-free rationales (MFCI-4/MFCI-5).
    expect(open[0]?.summary).toContain('Margins conditioned on');
    expect(open[0]?.appealSummary).not.toContain(storyId);
    // Re-delivery is idempotent: no duplicate open case.
    await fixture.events.hooks.mfci?.({
      target_ids: [storyId],
    } as never);
    expect(await fixture.invariants.mfciCases.listOpen(10)).toHaveLength(1);
    // Resolution.
    const caseId = open[0]?.caseId ?? '';
    const resolved = await fixture.invariants.mfciCases.resolve(
      caseId,
      'cleared',
      'steward:test',
      new Date().toISOString(),
    );
    expect(resolved?.status).toBe('cleared');
    expect(await fixture.invariants.mfciCases.listOpen(10)).toHaveLength(0);
  });

  it('batch fiber test attributes per-target scores under one shared conditioning', async () => {
    const fixture = freshInvariantServices();
    const { userId } = await seedUserWithSession(fixture.identity);
    const { storyId } = await seedStory(fixture, { topicIds: ['water'] });
    const { storyId: quietId } = await seedStory(fixture, { topicIds: ['water'] });
    const nowMs = Date.now();
    const window = hourWindow(nowMs);
    // 12 burst actions on one story; a single organic action on the other.
    const rows = Array.from({ length: 12 }, (_, i) => ({
      eventId: randomUUID(),
      eventType: 'contribution.created',
      topic: 'contribution.created',
      timestamp: new Date(Date.parse(window.start) + 60_000 + i * 120_000).toISOString(),
      privacyClassification: 'public' as const,
      retentionTier: 'public_contribution' as const,
      payload: { story_id: storyId },
      ownerUserId: i % 2 === 0 ? userId : null,
      purgeAfter: null,
    }));
    rows.push({
      eventId: randomUUID(),
      eventType: 'contribution.created',
      topic: 'contribution.created',
      timestamp: new Date(Date.parse(window.start) + 90_000).toISOString(),
      privacyClassification: 'public' as const,
      retentionTier: 'public_contribution' as const,
      payload: { story_id: quietId },
      ownerUserId: null,
      purgeAfter: null,
    });
    await fixture.events.eventStore.insertMany(rows);
    const outputs = await fixture.invariants.mfci.computeBatch(
      [
        { targetType: 'story', targetId: storyId },
        { targetType: 'story', targetId: quietId },
      ],
      window,
    );
    expect(outputs).toHaveLength(2);
    const hot = outputs.find((o) => o.target.targetId === storyId);
    const quiet = outputs.find((o) => o.target.targetId === quietId);
    const hotMfci = hot?.score_vector['mfci'];
    const quietMfci = quiet?.score_vector['mfci'];
    expect(typeof hotMfci).toBe('number');
    expect(Number.isFinite(hotMfci)).toBe(true);
    // Attribution: the burst target scores at least as extreme as the
    // single-action target — never inherited the other way around.
    expect(hotMfci as number).toBeGreaterThanOrEqual(quietMfci as number);
    // The conditioning is genuinely SHARED: one content-addressed margins
    // ref per window, identical across targets, never a dangling id.
    const ref = hot?.score_vector['fixed_margins_ref'];
    expect(ref).toMatch(/^margins:.+:[0-9a-f]+$/);
    expect(quiet?.score_vector['fixed_margins_ref']).toBe(ref);
    expect(hot?.score_vector['risk_state']).toBeDefined();
    // MFCI-4: the ref RESOLVES to the persisted conditioning record.
    const persisted = await fixture.invariants.mfciMargins.get(ref as string);
    expect(persisted?.windowStart).toBe(window.start);
    expect(persisted?.margins.axes).toEqual([
      'user_group',
      'topic',
      'time_bucket',
      'action_type',
      'target',
    ]);
    expect(persisted?.margins.total).toBe(13);
  });

  it('risk states rise on a same-group burst and clear only via a converged fiber test', async () => {
    // PINNED clock (Date only — no timer faking): the fiber test's MH seed
    // derives from the content-addressed margins ref, which embeds the hour
    // window's ABSOLUTE timestamps. With a wall-clock window the seed
    // changes every hour and the finite-sample p̂ estimate straddles the
    // score threshold on some seeds — a once-per-hour lottery. Pinning the
    // instant pins the windows, the margins hash, and therefore the seed:
    // the same deterministic-baseline discipline the WS-H regression
    // harness uses.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-06-12T06:55:00.000Z'));
    try {
      await runBurstAndClearScenario();
    } finally {
      vi.useRealTimers();
    }
  });

  async function runBurstAndClearScenario(): Promise<void> {
    const fixture = freshInvariantServices();
    const { userId } = await seedUserWithSession(fixture.identity);
    const { storyId: hot } = await seedStory(fixture, { topicIds: ['water'] });
    const others: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      others.push((await seedStory(fixture, { topicIds: ['misc'] })).storyId);
    }
    const nowMs = Date.now();
    const windowA = hourWindow(nowMs - 3_600_000);
    const windowB = hourWindow(nowMs);
    const row = (storyId: string, ts: number, owned: boolean) => ({
      eventId: randomUUID(),
      eventType: 'contribution.created',
      topic: 'contribution.created',
      timestamp: new Date(ts).toISOString(),
      privacyClassification: 'public' as const,
      retentionTier: 'public_contribution' as const,
      payload: { story_id: storyId },
      ownerUserId: owned ? userId : null,
      purgeAfter: null,
    });
    // Window A: every burst action from ONE account-age group (coordination
    // along the group axis), against a scattered anonymous background.
    await fixture.events.eventStore.insertMany([
      ...Array.from({ length: 12 }, (_, i) =>
        row(hot, Date.parse(windowA.start) + 60_000 + i * 120_000, true),
      ),
      ...Array.from({ length: 6 }, (_, i) =>
        row(others[i] ?? '', Date.parse(windowA.start) + 90_000 + i * 480_000, false),
      ),
    ]);
    const [outA] = await fixture.invariants.mfci.computeBatch(
      [{ targetType: 'story', targetId: hot }],
      windowA,
    );
    const afterBurst = await fixture.invariants.mfciRiskStates.get(hot);
    // Upward follows the score immediately — convergence evidence is NOT
    // required to raise (the burst table mixes slowly by nature).
    expect(outA?.score_vector['mfci']).toBeGreaterThan(3);
    expect(afterBurst?.state).not.toBe('normal');
    expect(afterBurst?.reason).toBe('score');
    expect(outA?.score_vector['risk_state']).toBe(afterBurst?.state);

    // Window B: organic scattered activity (one touch on the target). The
    // exact fiber test converges and scores the target at the null —
    // clearing evidence, so the held state releases downward.
    await fixture.events.eventStore.insertMany([
      row(hot, Date.parse(windowB.start) + 60_000, true),
      ...Array.from({ length: 6 }, (_, i) =>
        row(others[i] ?? '', Date.parse(windowB.start) + 120_000 + i * 480_000, i % 2 === 0),
      ),
    ]);
    const [outB] = await fixture.invariants.mfci.computeBatch(
      [{ targetType: 'story', targetId: hot }],
      windowB,
    );
    expect(outB?.reason_codes).toEqual([]); // converged
    const cleared = await fixture.invariants.mfciRiskStates.get(hot);
    expect(cleared?.state).toBe('normal');
    expect(cleared?.reason).toBe('fiber_cleared');
    expect(outB?.score_vector['risk_state']).toBe('normal');
  }
});

describe('SCOI service (WS-H.4)', () => {
  it('reports INSUFFICIENT_COVERAGE without two interpreted lenses', async () => {
    const fixture = freshInvariantServices();
    const { storyId } = await seedStory(fixture);
    const [output] = await fixture.invariants.scoi.computeBatch(
      [{ targetType: 'story', targetId: storyId }],
      hourWindow(Date.now()),
    );
    expect(output?.reason_codes).toContain('INSUFFICIENT_COVERAGE');
    expect(output?.confidence).toBe(0);
  });
});

describe('PHI sessions (WS-H.6) + path signature (WS-H.7.6)', () => {
  async function seedSession(
    fixture: InvariantServicesFixture,
    topicA: string,
    topicB: string,
  ): Promise<string> {
    const { userId } = await seedUserWithSession(fixture.identity);
    const { storyId: storyA } = await seedStory(fixture, { topicIds: [topicA] });
    const { storyId: storyB } = await seedStory(fixture, { topicIds: [topicB] });
    const base = Date.now() - 25 * 60_000; // all visits inside the 30-min window
    // a → b → a → b → a: a narrow loop on topicA with re-entries.
    const visits = [storyA, storyB, storyA, storyB, storyA];
    for (let i = 0; i < visits.length; i += 1) {
      await fixture.events.router.publish(
        attentionEvent(userId, {
          storyId: visits[i] ?? storyA,
          timestamp: new Date(base + i * 4 * 60_000).toISOString(),
        }),
      );
    }
    return userId;
  }

  it('the consumer stores topic ids, timing, and §22.1-coarse buckets ONLY (privacy)', async () => {
    const fixture = freshInvariantServices();
    await seedSession(fixture, 'topic-a', 'topic-b');
    const live = await fixture.invariants.sessions.listLive(Date.now());
    expect(live.length).toBe(1);
    const sequence = live[0]?.sequence ?? [];
    expect(sequence.length).toBe(5);
    for (const transition of sequence) {
      // The CLOSED record vocabulary: topic + instant + the aggregate's own
      // coarse action/engagement buckets — nothing else, ever.
      expect(Object.keys(transition).sort()).toEqual([
        'atMs',
        'engagement',
        'kind',
        'topicClusterId',
      ]);
      expect(['topic-a', 'topic-b']).toContain(transition.topicClusterId);
      expect(['read', 'open_source', 'open_context']).toContain(transition.kind);
      expect(transition.engagement).toBeGreaterThanOrEqual(0);
      expect(transition.engagement).toBeLessThanOrEqual(1);
      // No story id, no user id, no content anywhere in the record.
      expect(JSON.stringify(transition)).not.toMatch(/story|user|body/);
    }
    // The session key is an opaque digest, not the user id.
    expect(live[0]?.sessionKey).toMatch(/^[0-9a-f]{32}$/);
  });

  it('a ping-pong revisit walk scores PHI 0 honestly (no cycle content)', async () => {
    const fixture = freshInvariantServices();
    await seedSession(fixture, 'topic-a', 'topic-b');
    const outputs = await fixture.invariants.phi.computeBatch([], hourWindow(Date.now()));
    expect(outputs.length).toBe(1);
    const output = outputs[0];
    expect(output?.target.targetType).toBe('session');
    // a → b → a → b → a bounds no area: under the symmetric Kabsch
    // connection its holonomy is the identity BY GEOMETRY — full-coverage
    // PHI 0, never a coverage gap.
    expect(output?.reason_codes).toEqual([]);
    expect(output?.score_vector['phi']).toBe(0);
    expect(output?.score_vector['cycle_content']).toBe(false);
    expect(output?.coverage).toBe(1);
  });

  /** Seed a genuine 3-topic cycle a → b → c → a → b → c → a with enough
   * per-topic stories to estimate behavioral structures. */
  async function seedCycleSession(
    fixture: InvariantServicesFixture,
    topics: readonly string[],
    options: { structureStories?: number; sensitivityLabels?: SensitivityLabel[] } = {},
  ): Promise<void> {
    const { userId } = await seedUserWithSession(fixture.identity);
    const visited: string[] = [];
    for (const topic of topics) {
      const { storyId } = await seedStory(fixture, {
        topicIds: [topic],
        title: `Field report on ${topic} infrastructure and policy`,
        ...(options.sensitivityLabels ? { sensitivityLabels: options.sensitivityLabels } : {}),
      });
      visited.push(storyId);
      for (let i = 0; i < (options.structureStories ?? 4); i += 1) {
        await seedStory(fixture, {
          topicIds: [topic],
          title: `${topic} perspective ${i}: community questions evidence analysis ${i * 7}`,
        });
      }
    }
    const base = Date.now() - 28 * 60_000;
    const pattern = [0, 1, 2, 0, 1, 2, 0];
    for (const [i, idx] of pattern.entries()) {
      await fixture.events.router.publish(
        attentionEvent(userId, {
          storyId: visited[idx] ?? '',
          timestamp: new Date(base + i * 4 * 60_000).toISOString(),
        }),
      );
    }
  }

  it('a genuine 3-topic cycle yields pair-transport holonomy', async () => {
    const fixture = freshInvariantServices();
    await seedCycleSession(fixture, ['cycle-a', 'cycle-b', 'cycle-c']);
    const outputs = await fixture.invariants.phi.computeBatch([], hourWindow(Date.now()));
    expect(outputs.length).toBe(1);
    const output = outputs[0];
    expect(output?.target.targetType).toBe('session');
    if (output?.reason_codes.includes('INSUFFICIENT_COVERAGE')) {
      throw new Error('structures should be estimable from the seeded per-topic stories');
    }
    expect(output?.coverage).toBe(1);
    expect(output?.score_vector['cycle_content']).toBe(true);
    // NON-VACUOUS: pair transports pick up genuine curvature on a real
    // cycle (per-topic frames would force exactly 0 here — the
    // flat-connection theorem, tested in @licio/invariants).
    expect(output?.score_vector['phi']).toBeGreaterThan(0.001);
    expect(Number.isFinite(output?.score_vector['phi'])).toBe(true);
    expect(output?.score_vector['alignment_conditioning']).toBeGreaterThan(0);
    // The reduced cycle, not the raw revisit walk, is the loop path.
    expect(output?.score_vector['loop_path']).toEqual([
      'cycle-a',
      'cycle-b',
      'cycle-c',
      'cycle-a',
      'cycle-b',
      'cycle-c',
      'cycle-a',
    ]);
    // Gauge boundary: only invariant fields on the vector.
    expect(Object.keys(output?.score_vector ?? {}).sort()).toEqual(
      [
        'alignment_conditioning',
        'cycle_content',
        'fallback_log',
        'loop_length',
        'loop_path',
        'phi',
        'rotation_angles',
        'sensitive',
        'trace',
      ].sort(),
    );
  });

  it('sensitive topics are detected at the stricter repeat threshold (PHI-3)', async () => {
    const fixture = freshInvariantServices();
    const { userId } = await seedUserWithSession(fixture.identity);
    // The flagged cluster repeats only TWICE — under the base threshold (3),
    // at the sensitive-adjusted threshold (2).
    const seedPair = async (topic: string, labels: SensitivityLabel[]): Promise<string[]> => {
      const { storyId: hub } = await seedStory(fixture, {
        topicIds: [topic],
        ...(labels.length > 0 ? { sensitivityLabels: labels } : {}),
      });
      const { storyId: spoke } = await seedStory(fixture, { topicIds: [`${topic}-other`] });
      return [hub, spoke, hub];
    };
    const sensitiveVisits = await seedPair('sensitive-x', ['crisis']);
    const ordinaryVisits = await seedPair('ordinary-y', []);
    const base = Date.now() - 20 * 60_000;
    for (const [i, storyId] of sensitiveVisits.entries()) {
      await fixture.events.router.publish(
        attentionEvent(userId, {
          storyId,
          timestamp: new Date(base + i * 4 * 60_000).toISOString(),
        }),
      );
    }
    const { userId: otherUser } = await seedUserWithSession(fixture.identity);
    for (const [i, storyId] of ordinaryVisits.entries()) {
      await fixture.events.router.publish(
        attentionEvent(otherUser, {
          storyId,
          timestamp: new Date(base + i * 4 * 60_000).toISOString(),
        }),
      );
    }
    const outputs = await fixture.invariants.phi.computeBatch([], hourWindow(Date.now()));
    // Only the SENSITIVE session is flagged at the stricter threshold; the
    // ordinary session with the same shape stays below the base threshold.
    expect(outputs.length).toBe(1);
    expect(outputs[0]?.score_vector['sensitive']).toBe(true);
    expect(outputs[0]?.score_vector['cycle_content']).toBe(false);
  });

  it('path-signature classifies the same session data without content', async () => {
    const fixture = freshInvariantServices();
    await seedSession(fixture, 'topic-a', 'topic-b');
    const outputs = await fixture.invariants.pathsig.computeBatch([], hourWindow(Date.now()));
    expect(outputs.length).toBe(1);
    const classification = outputs[0]?.score_vector['classification'];
    expect(typeof classification).toBe('string');
    // Re-entries map to `return` events in the path encoding.
    const events = sessionEventsFromSequence(
      (await fixture.invariants.sessions.listLive(Date.now()))[0]?.sequence ?? [],
    );
    expect(events.filter((e) => e.kind === 'return').length).toBeGreaterThan(0);
  });

  it('source-seeking sessions carry coarse action kinds and reach CONSTRUCTIVE', async () => {
    const fixture = freshInvariantServices();
    const { userId } = await seedUserWithSession(fixture.identity);
    const base = Date.now() - 25 * 60_000;
    // Distinct topics opened with the source each time: deliberate,
    // source-seeking behavior — the §22.1 aggregate's own coarse booleans
    // make the action kind recoverable without any new information class.
    for (const [i, topic] of ['t-a', 't-b', 't-c', 't-d'].entries()) {
      const { storyId } = await seedStory(fixture, { topicIds: [topic] });
      await fixture.events.router.publish(
        attentionEvent(userId, {
          storyId,
          timestamp: new Date(base + i * 5 * 60_000).toISOString(),
          items: [
            {
              story_id: storyId,
              active_dwell_bucket: 'extended',
              source_opened: true,
              context_opened: false,
              branch_depth_bucket: 'shallow',
              return_visit_count_bucket: 'none',
            },
          ],
        } as never),
      );
    }
    const sequence = (await fixture.invariants.sessions.listLive(Date.now()))[0]?.sequence ?? [];
    expect(sequence.length).toBe(4);
    for (const transition of sequence) {
      expect(transition.kind).toBe('open_source');
      expect(transition.engagement).toBe(1);
      // Still no story id, no content, no other identity.
      expect(JSON.stringify(transition)).not.toMatch(/story|body|user/);
    }
    const events = sessionEventsFromSequence(sequence);
    expect(events.every((e) => e.kind === 'open_source')).toBe(true);
    const outputs = await fixture.invariants.pathsig.computeBatch([], hourWindow(Date.now()));
    expect(outputs[0]?.score_vector['classification']).toBe('constructive');
  });

  it('expired sequences sweep away (session-scoped retention)', async () => {
    const fixture = freshInvariantServices();
    await seedSession(fixture, 'topic-a', 'topic-b');
    const future = Date.now() + 7 * 3_600_000;
    expect(await fixture.invariants.sessions.sweepExpired(future)).toBe(1);
    expect(await fixture.invariants.sessions.listLive(future)).toEqual([]);
  });
});

describe('MERI citation lineage pages past the first 500 contributions', () => {
  it('a sourced comment beyond page one still contributes its lineage token', async () => {
    const fixture = freshInvariantServices();
    const { threadId } = await seedStory(fixture);
    const author = randomUUID();
    // 501 citation-less comments occupy the first page…
    const base = Date.now() - 601_000;
    for (let i = 0; i < 501; i += 1) {
      const inserted = await fixture.forum.contributions.insert({
        contributionId: randomUUID(),
        threadId,
        userId: author,
        type: 'comment',
        body: `Filler ${i}`,
        citations: [],
        metadata: {},
        targetClaimId: null,
        parentContributionId: null,
        clientDraftId: `fill-${i}`,
        path: [],
        moderationState: 'published',
      });
      if (!inserted.ok) throw new Error('seed failed');
      void base;
    }
    // …and the ONLY sourced comment lands beyond it.
    const cited = await fixture.forum.contributions.insert({
      contributionId: randomUUID(),
      threadId,
      userId: author,
      type: 'comment',
      body: 'The registry copy confirms it.',
      citations: [{ url: 'https://records.example.org/registry' }],
      metadata: {},
      targetClaimId: null,
      parentContributionId: null,
      clientDraftId: 'cited-tail',
      path: [],
      moderationState: 'published',
    });
    if (!cited.ok) throw new Error('seed failed');
    const candidates = await assembleMeriCandidates(
      fixture.ingestion,
      fixture.forum,
      null,
      100,
      0.7,
      0.85,
    );
    const withLineage = candidates.find((c) => (c.independence?.evidenceGroupIds.length ?? 0) > 0);
    expect(withLineage?.independence?.evidenceGroupIds).toContain('cit:example.org');
  });
});

describe('supporting invariant services (WS-H.7)', () => {
  it('Hodge labels a seeded conversation without hostility penalty', async () => {
    const fixture = freshInvariantServices();
    const { threadId } = await seedStory(fixture);
    const alice = randomUUID();
    const bob = randomUUID();
    const root = await fixture.forum.contributions.insert({
      contributionId: randomUUID(),
      threadId,
      userId: alice,
      type: 'comment',
      body: 'What does the report actually claim?',
      citations: [],
      metadata: {},
      targetClaimId: null,
      parentContributionId: null,
      clientDraftId: randomUUID(),
      path: [],
      moderationState: 'published',
    });
    if (!root.ok) throw new Error('seed root failed');
    const reply = await fixture.forum.contributions.insert({
      contributionId: randomUUID(),
      threadId,
      userId: bob,
      type: 'comment',
      body: 'It claims the levels fell within bounds.',
      citations: [],
      metadata: {},
      targetClaimId: null,
      parentContributionId: root.contribution.contributionId,
      clientDraftId: randomUUID(),
      path: [root.contribution.contributionId],
      moderationState: 'published',
    });
    if (!reply.ok) throw new Error('seed reply failed');
    const [output] = await fixture.invariants.hodge.computeBatch(
      [{ targetType: 'thread', targetId: threadId }],
      hourWindow(Date.now()),
    );
    expect(output).toBeTruthy();
    // Hostility seam defaults to zero ⇒ HarmfulTensionRisk is exactly 0.
    expect(output?.score_vector['harmful_tension_risk']).toBe(0);
    expect(typeof output?.score_vector['label']).toBe('string');
  });

  it('CID certifies the attribute-blind v0 ranking with CID = 0', async () => {
    const fixture = freshInvariantServices();
    await seedStory(fixture);
    const [output] = await fixture.invariants.cid.computeBatch([], hourWindow(Date.now()));
    expect(output?.score_vector['cid']).toBe(0);
    expect(output?.score_vector['blocked']).toBe(false);
  });

  it('tropical + braid + reeb run on seeded data without errors', async () => {
    const fixture = freshInvariantServices();
    await seedStory(fixture, { topicIds: ['water'] });
    await seedStory(fixture, { topicIds: ['water'] });
    await seedStory(fixture, { topicIds: ['transit'] });
    const window = hourWindow(Date.now());
    const tropical = await fixture.invariants.tropical.computeBatch([], window);
    expect(tropical.length).toBeGreaterThan(0);
    const braid = await fixture.invariants.braid.computeBatch([], window);
    expect(braid.length).toBe(1);
    const reeb = await fixture.invariants.reeb.computeBatch([], window);
    expect(reeb[0]?.score_vector['peak_count']).toBeGreaterThanOrEqual(0);
  });
});
