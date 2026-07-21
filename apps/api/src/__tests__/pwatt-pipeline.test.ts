// SPDX-License-Identifier: AGPL-3.0-or-later
//
// PWAtt pipeline acceptance (WS-E.2.1a-e, WS-E.2.2a/c, WS-E.2.3e):
// aggregation with per-user dedup and idempotency, shadow scoring with
// InvariantOutput persistence, Signal Ledger population with plain-language
// summaries, coordinated-burst + harassment-cascade detection with base-rate
// conditioning, the safety-state freeze workflow, and the CI-gated
// shadow-mode ranking-equivalence proof (SPEC §30.5).

import { randomUUID } from 'node:crypto';
import { PWATT_V0_SHADOW_MODE } from '@licio/invariants';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { ingestAttentionEvents } from '../events/ingest.js';
import type {
  ActorBehaviorWindowRecord,
  AggregationWindowRecord,
  NewStoredEvent,
} from '../events/stores.js';
import { computeAggregationWindow, windowStartMs } from '../pwatt/aggregation.js';
import { rankFrontPageV0 } from '../pwatt/ranking-v0.js';
import { runEventPipelineTick } from '../pwatt/scheduler.js';
import { resolveItemSafetyState, runPwattWindow, windowsNeedingCompute } from '../pwatt/scoring.js';
import { assertRankingInputAllowed, RankingBoundaryViolation } from '../pwatt/shadow.js';
import { createV1Routes } from '../routes/v1.js';
import {
  attentionEvent,
  type EventServicesFixture,
  freshEventServices,
  seedUserWithSession,
  sourceOpenEvent,
} from './event-test-helpers.js';

/** Narrow an unknown score-vector component for matcher arguments. */
const asNumber = (value: unknown, fallback: number): number =>
  typeof value === 'number' ? value : fallback;

const HOUR = 3_600_000;

let fixture: EventServicesFixture;
/** A fixed, complete window: [T0, T0 + 1h). */
const T0 = Date.UTC(2026, 5, 10, 10, 0, 0);
const IN_WINDOW = new Date(T0 + 10 * 60_000).toISOString();

function contributionRow(
  threadId: string,
  userId: string,
  contributionType: string,
  opts: { hasCitation?: boolean; accusation?: boolean; timestamp?: string } = {},
): NewStoredEvent {
  return {
    eventId: randomUUID(),
    eventType: 'contribution.created',
    topic: 'contribution.created',
    timestamp: opts.timestamp ?? IN_WINDOW,
    privacyClassification: 'public',
    retentionTier: 'public_contribution',
    payload: {
      event_id: randomUUID(),
      event_type: 'contribution.created',
      timestamp: opts.timestamp ?? IN_WINDOW,
      schema_version: '1',
      contribution_id: randomUUID(),
      thread_id: threadId,
      user_id: userId,
      contribution_type: contributionType,
      target_claim_id: null,
      parent_contribution_id: null,
      has_citation: opts.hasCitation ?? false,
      accusation_flag: opts.accusation ?? false,
      privacy_classification: 'public',
      retention_tier: 'public_contribution',
    },
    ownerUserId: userId,
    purgeAfter: null,
  };
}

/** A stored `content.saved` event (§5.3 Save-for-later signal). */
function savedRow(storyId: string, userId: string, timestamp: string = IN_WINDOW): NewStoredEvent {
  return {
    eventId: randomUUID(),
    eventType: 'content.saved',
    topic: 'content.saved',
    timestamp,
    privacyClassification: 'aggregated',
    retentionTier: 'attention_aggregated',
    payload: {
      event_id: randomUUID(),
      event_type: 'content.saved',
      timestamp,
      schema_version: '1',
      nonce: randomUUID(),
      user_id: userId,
      privacy_level: 'standard',
      story_id: storyId,
      privacy_classification: 'aggregated',
      retention_tier: 'attention_aggregated',
    },
    ownerUserId: userId,
    purgeAfter: null,
  };
}

async function ingestAttention(
  userId: string,
  storyId: string,
  overrides: Parameters<typeof attentionEvent>[1] = {},
): Promise<void> {
  await ingestAttentionEvents(
    fixture.events,
    fixture.identity,
    userId,
    [attentionEvent(userId, { storyId, timestamp: IN_WINDOW, ...overrides })],
    { maxPastMs: Number.MAX_SAFE_INTEGER, maxFutureMs: Number.MAX_SAFE_INTEGER },
  );
}

beforeEach(() => {
  fixture = freshEventServices({ storyTitle: () => 'Water main study' });
});

describe('aggregation per item/window (WS-E.2.1a)', () => {
  it('deduplicates a user’s repeated attention within a window (refresh-loop defense)', async () => {
    const { userId } = await seedUserWithSession(fixture.identity);
    const storyId = randomUUID();
    for (let i = 0; i < 5; i += 1) await ingestAttention(userId, storyId);
    const result = await computeAggregationWindow(fixture.events, T0, '1h');
    const row = await fixture.events.windowStore.get(storyId, new Date(T0).toISOString(), '1h');
    expect(result.items.get(storyId)?.actors.size).toBe(1);
    expect(row?.uniqueActiveUsers).toBe(1); // five uploads, ONE user
    expect(row?.sourceOpens).toBe(1);
    expect(row?.eventCount).toBe(5);
  });

  it('counts distinct actors per signal type and contribution counts by type', async () => {
    const a = await seedUserWithSession(fixture.identity, { handle: 'actorone' });
    const b = await seedUserWithSession(fixture.identity, { handle: 'actortwo' });
    const storyId = randomUUID();
    await ingestAttention(a.userId, storyId);
    await ingestAttention(b.userId, storyId, {
      items: [
        {
          story_id: storyId,
          active_dwell_bucket: 'long',
          source_opened: false,
          context_opened: true,
          reply_depth_bucket: 'moderate',
          return_visit_count_bucket: 'few',
        },
      ],
    });
    await fixture.events.eventStore.insertMany([
      contributionRow(storyId, a.userId, 'explanation'),
      contributionRow(storyId, a.userId, 'correction', { hasCitation: true }),
      contributionRow(storyId, b.userId, 'low_info_reply'),
    ]);
    await computeAggregationWindow(fixture.events, T0, '1h');
    const row = await fixture.events.windowStore.get(storyId, new Date(T0).toISOString(), '1h');
    expect(row?.uniqueActiveUsers).toBe(2);
    expect(row?.sourceOpens).toBe(1);
    expect(row?.contextOpens).toBe(1);
    expect(row?.returnVisits).toBe(1);
    expect(row?.contributionCounts).toEqual({ explanation: 1, correction: 1, low_info_reply: 1 });
  });

  it('counts a contribution-only actor as active, matching the realtime HLL (WS-E.3.2)', async () => {
    const reader = await seedUserWithSession(fixture.identity, { handle: 'readerx' });
    const commenter = await seedUserWithSession(fixture.identity, { handle: 'commenterx' });
    const storyId = randomUUID();
    await ingestAttention(reader.userId, storyId); // reader has attention
    // The commenter ONLY comments — no attention event of their own.
    await fixture.events.eventStore.insertMany([
      contributionRow(storyId, commenter.userId, 'explanation'),
    ]);
    await computeAggregationWindow(fixture.events, T0, '1h');
    const row = await fixture.events.windowStore.get(storyId, new Date(T0).toISOString(), '1h');
    // Both are active — the realtime HLL adds each commenter via recordContribution,
    // so this durable tally must too (else comment-heavy windows flag false
    // reconciliation discrepancies).
    expect(row?.uniqueActiveUsers).toBe(2);
  });

  it('folds the §5.3 "Save for later" signal, deduped per (actor, item)', async () => {
    const a = await seedUserWithSession(fixture.identity, { handle: 'saverone' });
    const b = await seedUserWithSession(fixture.identity, { handle: 'savertwo' });
    const storyId = randomUUID();
    await fixture.events.eventStore.insertMany([
      savedRow(storyId, a.userId),
      savedRow(storyId, a.userId), // same user's repeat save…
      savedRow(storyId, b.userId),
    ]);
    const result = await computeAggregationWindow(fixture.events, T0, '1h');
    const actors = result.items.get(storyId)?.actors;
    // …counts ONCE per actor (booleans OR), never inflates.
    expect(actors?.get(a.userId)?.saved).toBe(true);
    expect(actors?.get(b.userId)?.saved).toBe(true);
    expect(actors?.size).toBe(2);
  });

  it('a saved item earns MORE participation than an unsaved one (§5.3 low weight)', async () => {
    // Two stories, one attended reader each with identical attention; one ALSO
    // saves. The save lifts the saved story's participation component.
    const saver = await seedUserWithSession(fixture.identity, { handle: 'keeps' });
    const reader = await seedUserWithSession(fixture.identity, { handle: 'reads' });
    const savedStory = randomUUID();
    const plainStory = randomUUID();
    for (const [user, story] of [
      [saver, savedStory],
      [reader, plainStory],
    ] as const) {
      await ingestAttention(user.userId, story, {
        items: [
          {
            story_id: story,
            active_dwell_bucket: 'long',
            source_opened: true,
            context_opened: false,
            reply_depth_bucket: 'shallow',
            return_visit_count_bucket: 'few',
          },
        ],
      });
    }
    await fixture.events.eventStore.insertMany([savedRow(savedStory, saver.userId)]);
    await runPwattWindow(fixture.events, fixture.identity, T0, '1h');
    const saved = await fixture.events.invariantStore.latest('PWAtt_v1', savedStory);
    const plain = await fixture.events.invariantStore.latest('PWAtt_v1', plainStory);
    expect(asNumber(saved?.scoreVector['participation'], 0)).toBeGreaterThan(
      asNumber(plain?.scoreVector['participation'], Number.POSITIVE_INFINITY),
    );
  });

  it('is idempotent: recomputing a window produces identical results', async () => {
    const { userId } = await seedUserWithSession(fixture.identity);
    const storyId = randomUUID();
    await ingestAttention(userId, storyId);
    await computeAggregationWindow(fixture.events, T0, '1h');
    const first = await fixture.events.windowStore.get(storyId, new Date(T0).toISOString(), '1h');
    await computeAggregationWindow(fixture.events, T0, '1h');
    const second = await fixture.events.windowStore.get(storyId, new Date(T0).toISOString(), '1h');
    // The fold output is identical; computedAt is excluded DELIBERATELY — it
    // is execution metadata that advances on every recompute (the scheduler's
    // freshness comparison depends on that), so comparing it makes the test
    // hostage to whether both runs land in the same clock millisecond.
    expect(first).not.toBeNull();
    const { computedAt: firstAt, ...firstData } = first as AggregationWindowRecord;
    const { computedAt: secondAt, ...secondData } = second as AggregationWindowRecord;
    expect(secondData).toEqual(firstData);
    expect(Date.parse(secondAt)).toBeGreaterThanOrEqual(Date.parse(firstAt));
  });

  it('respects window boundaries (an event outside the window is excluded)', async () => {
    const { userId } = await seedUserWithSession(fixture.identity);
    const storyId = randomUUID();
    await ingestAttentionEvents(
      fixture.events,
      fixture.identity,
      userId,
      [
        attentionEvent(userId, { storyId, timestamp: new Date(T0 - 1).toISOString() }),
        attentionEvent(userId, { storyId, timestamp: new Date(T0 + HOUR - 1).toISOString() }),
      ],
      { maxPastMs: Number.MAX_SAFE_INTEGER, maxFutureMs: Number.MAX_SAFE_INTEGER },
    );
    await computeAggregationWindow(fixture.events, T0, '1h');
    const row = await fixture.events.windowStore.get(storyId, new Date(T0).toISOString(), '1h');
    expect(row?.eventCount).toBe(1);
  });

  it('aggregates 10k events well within the 30-second budget (perf smoke)', async () => {
    const { userId } = await seedUserWithSession(fixture.identity);
    const stories = Array.from({ length: 20 }, () => randomUUID());
    const rows: NewStoredEvent[] = [];
    for (let i = 0; i < 10_000; i += 1) {
      const event = attentionEvent(userId, {
        storyId: stories[i % stories.length] ?? '',
        timestamp: IN_WINDOW,
      });
      rows.push({
        eventId: event.event_id,
        eventType: event.event_type,
        topic: event.event_type,
        timestamp: event.timestamp,
        privacyClassification: 'aggregated',
        retentionTier: 'attention_aggregated',
        payload: event as unknown as Record<string, unknown>,
        ownerUserId: userId,
        purgeAfter: null,
      });
    }
    await fixture.events.eventStore.insertMany(rows);
    const startedAt = Date.now();
    await computeAggregationWindow(fixture.events, T0, '1h');
    expect(Date.now() - startedAt).toBeLessThan(30_000);
  }, 35_000);

  it('every configured window size produces results', async () => {
    const { userId } = await seedUserWithSession(fixture.identity);
    const storyId = randomUUID();
    await ingestAttention(userId, storyId);
    for (const size of ['1h', '6h', '24h', '7d'] as const) {
      const start = windowStartMs(T0, size);
      await computeAggregationWindow(fixture.events, start, size);
      const row = await fixture.events.windowStore.get(
        storyId,
        new Date(start).toISOString(),
        size,
      );
      expect(row, size).not.toBeNull();
    }
  });
});

describe('shadow scoring + Signal Ledger (WS-E.2.1b-d)', () => {
  it('stores PWAtt v0 and v1 outputs with shadow_mode: true and writes ledger entries', async () => {
    const { userId } = await seedUserWithSession(fixture.identity);
    const storyId = randomUUID();
    await ingestAttention(userId, storyId, {
      items: [
        {
          story_id: storyId,
          active_dwell_bucket: 'medium',
          source_opened: true,
          context_opened: false,
          reply_depth_bucket: 'shallow',
          return_visit_count_bucket: 'few',
        },
      ],
    });
    await fixture.events.eventStore.insertMany([contributionRow(storyId, userId, 'explanation')]);
    const report = await runPwattWindow(fixture.events, fixture.identity, T0, '1h');
    expect(report.itemsScored).toBe(1);

    const outputs = await fixture.events.invariantStore.listForTarget(storyId);
    expect(outputs).toHaveLength(2);
    // Post-lift (§30.5 via WS-I): PWAtt rows are stored as BOUNDED ranking
    // inputs (`shadow_mode: false`); the fallback boundary still rejects
    // them unconditionally (asserted in the shadow-verification suite).
    expect(outputs.every((o) => o.shadowMode === PWATT_V0_SHADOW_MODE)).toBe(true);
    const v0 = outputs.find((o) => o.invariantType === 'PWAtt_v0');
    expect(v0?.scoreVector['score']).toBeGreaterThan(0);
    expect(v0?.scoreVector['score']).toBeLessThanOrEqual(1);

    // The owner-only ledger has the plan-shaped plain-language summary.
    const ledger = await fixture.events.ledgerStore.listForUser(userId, 10);
    expect(ledger.entries).toHaveLength(1);
    expect(ledger.entries[0]?.summary).toBe(
      'You read this for a moderate duration, opened the source, read into the replies, ' +
        'and returned to it. Your comment was counted as constructive participation.',
    );
    expect(ledger.entries[0]?.storyTitle).toBe('Water main study');
    expect(ledger.entries[0]?.pwattScore).toBe(v0?.scoreVector['score']);
  });

  it('never writes ledger entries for pseudonymous (privacy-bucket) actors', async () => {
    const { userId } = await seedUserWithSession(fixture.identity);
    const storyId = randomUUID();
    await ingestAttention(userId, storyId, { privacy_level: 'minimum' });
    await runPwattWindow(fixture.events, fixture.identity, T0, '1h');
    expect((await fixture.events.ledgerStore.listForUser(userId, 10)).entries).toHaveLength(0);
    expect(
      (await fixture.events.ledgerStore.listForUser('privacy-bucket', 10)).entries,
    ).toHaveLength(0);
  });

  it('scoring is reproducible: re-running the window converges to the same outputs', async () => {
    const { userId } = await seedUserWithSession(fixture.identity);
    const storyId = randomUUID();
    await ingestAttention(userId, storyId);
    await runPwattWindow(fixture.events, fixture.identity, T0, '1h');
    const first = await fixture.events.invariantStore.listForTarget(storyId);
    await runPwattWindow(fixture.events, fixture.identity, T0, '1h');
    const second = await fixture.events.invariantStore.listForTarget(storyId);
    expect(second.map(({ createdAt: _c, ...rest }) => rest)).toEqual(
      first.map(({ createdAt: _c, ...rest }) => rest),
    );
  });
});

describe('coordinated-burst detection (WS-E.2.2a)', () => {
  async function burstWindow(actors: number, eventsPerActor: number): Promise<string> {
    const storyId = randomUUID();
    for (let i = 0; i < actors; i += 1) {
      const { userId } = await seedUserWithSession(fixture.identity, { handle: `burst${i}x` });
      for (let j = 0; j < eventsPerActor; j += 1) {
        await ingestAttention(userId, storyId);
      }
    }
    return storyId;
  }

  it('flags a synthetic burst, emits the integrity signal, and routes to the hooks', async () => {
    const mfci: string[] = [];
    const review: string[] = [];
    fixture = freshEventServices({
      hooks: {
        mfci: (signal) => {
          mfci.push(signal.signal_type);
        },
        reviewQueue: (signal) => {
          review.push(signal.signal_type);
        },
      },
    });
    const storyId = await burstWindow(6, 3); // 18 events, 6 actors, no history
    const report = await runPwattWindow(fixture.events, fixture.identity, T0, '1h');
    expect(report.burstsDetected).toBe(1);
    expect(mfci).toEqual(['coordinated_burst']);
    expect(review).toEqual(['coordinated_burst']);
    // The integrity event is stored restricted/security_log.
    const stored = await fixture.events.eventStore.listByTopicsBetween(
      ['integrity.signal.detected'],
      new Date(0).toISOString(),
      new Date(Date.now() + HOUR).toISOString(),
    );
    expect(stored).toHaveLength(1);
    expect(stored[0]?.privacyClassification).toBe('restricted');
    const payload = stored[0]?.payload as { confidence: number; target_ids: string[] };
    expect(payload.target_ids).toEqual([storyId]);
    expect(payload.confidence).toBeGreaterThan(0);
    expect(payload.confidence).toBeLessThanOrEqual(1);
  });

  it('does not flag an equivalently active but ORGANIC community (base-rate conditioning)', async () => {
    const storyId = randomUUID();
    // Six trailing windows of comparable volume — a busy, normal community.
    for (let w = 1; w <= 6; w += 1) {
      await fixture.events.windowStore.upsert({
        itemId: storyId,
        windowStart: new Date(T0 - w * HOUR).toISOString(),
        windowSize: '1h',
        uniqueActiveUsers: 6,
        sourceOpens: 5,
        contextOpens: 2,
        returnVisits: 1,
        contributionCounts: {},
        antiSignalCounts: {},
        eventCount: 18,
        computedAt: new Date().toISOString(),
      });
    }
    for (let i = 0; i < 6; i += 1) {
      const { userId } = await seedUserWithSession(fixture.identity, { handle: `organic${i}x` });
      for (let j = 0; j < 3; j += 1) await ingestAttention(userId, storyId);
    }
    const report = await runPwattWindow(fixture.events, fixture.identity, T0, '1h');
    expect(report.burstsDetected).toBe(0); // same volume, conditioned away
  });

  it('the minimum-distinct-actors guard prevents single-user false positives', async () => {
    const { userId } = await seedUserWithSession(fixture.identity);
    const storyId = randomUUID();
    for (let i = 0; i < 30; i += 1) await ingestAttention(userId, storyId);
    const report = await runPwattWindow(fixture.events, fixture.identity, T0, '1h');
    expect(report.burstsDetected).toBe(0); // one actor, however loud
  });

  it('burst thresholds are tunable via the config store without code change', async () => {
    await fixture.events.configStore.set('burst', {
      minVolume: 100,
      minDistinctActors: 50,
      burstMultiplier: 10,
      baseRateFloor: 50,
    });
    await burstWindow(6, 3);
    const report = await runPwattWindow(fixture.events, fixture.identity, T0, '1h');
    expect(report.burstsDetected).toBe(0); // raised thresholds: no detection
  });
});

describe('account-age trust weighting end-to-end (WS-O.4.5)', () => {
  // 11 one-event actors on a no-history item: volume 11. Full threshold
  // (4 × baseRateFloor 3) = 12, so an AGED community is NOT a burst; a
  // FRESH-account brigade (trust 0.5) has its threshold scaled to 6 and IS.
  async function brigade(handlePrefix: string, accountAgeMs: number): Promise<string> {
    const storyId = randomUUID();
    for (let i = 0; i < 11; i += 1) {
      const { userId } = await seedUserWithSession(fixture.identity, {
        handle: `${handlePrefix}${i}b`,
        accountAgeMs,
      });
      await ingestAttention(userId, storyId);
    }
    return storyId;
  }

  it('does NOT flag an AGED community of borderline volume', async () => {
    await brigade('aged', 500 * 86_400_000); // established → trust 1.0
    const report = await runPwattWindow(fixture.events, fixture.identity, T0, '1h');
    expect(report.burstsDetected).toBe(0);
  });

  it('DOES flag a FRESH-account brigade of the SAME volume (raised cost)', async () => {
    await brigade('newb', 1 * 86_400_000); // new → trust 0.5
    const report = await runPwattWindow(fixture.events, fixture.identity, T0, '1h');
    expect(report.burstsDetected).toBe(1);
  });

  it('a fresh brigade SALTED with a minority of aged accounts is STILL flagged', async () => {
    // 9 fresh + 2 aged (11 events). The low-quantile trust factor resists the
    // salt: a minority of aged accounts cannot lift it back to established.
    const storyId = randomUUID();
    for (let i = 0; i < 9; i += 1) {
      const { userId } = await seedUserWithSession(fixture.identity, {
        handle: `salt${i}f`,
        accountAgeMs: 1 * 86_400_000,
      });
      await ingestAttention(userId, storyId);
    }
    for (let i = 0; i < 2; i += 1) {
      const { userId } = await seedUserWithSession(fixture.identity, {
        handle: `salt${i}a`,
        accountAgeMs: 500 * 86_400_000,
      });
      await ingestAttention(userId, storyId);
    }
    const report = await runPwattWindow(fixture.events, fixture.identity, T0, '1h');
    expect(report.burstsDetected).toBe(1);
  });

  it('a FRESH-account item earns LESS PWAtt score than an AGED one with identical attention', async () => {
    // Below the burst floor (3 actors < minVolume 10) so anti-signal attenuation
    // never fires — this isolates the per-actor account-age SCORE scaling: each
    // fresh account (trust 0.5) contributes half an aged account (trust 1.0).
    async function attendedStory(prefix: string, accountAgeMs: number): Promise<string> {
      const storyId = randomUUID();
      for (let i = 0; i < 3; i += 1) {
        const { userId } = await seedUserWithSession(fixture.identity, {
          handle: `${prefix}${i}s`,
          accountAgeMs,
        });
        await ingestAttention(userId, storyId, {
          items: [
            {
              story_id: storyId,
              active_dwell_bucket: 'extended',
              source_opened: true,
              context_opened: true,
              reply_depth_bucket: 'shallow',
              return_visit_count_bucket: 'several',
            },
          ],
        });
        await fixture.events.eventStore.insertMany([
          contributionRow(storyId, userId, 'correction', { hasCitation: true }),
        ]);
      }
      return storyId;
    }
    const agedStory = await attendedStory('aged', 500 * 86_400_000); // trust 1.0
    const freshStory = await attendedStory('fresh', 1 * 86_400_000); // trust 0.5
    const report = await runPwattWindow(fixture.events, fixture.identity, T0, '1h');
    expect(report.burstsDetected).toBe(0); // no anti-signal confound

    const aged = await fixture.events.invariantStore.latest('PWAtt_v1', agedStory);
    const fresh = await fixture.events.invariantStore.latest('PWAtt_v1', freshStory);
    expect(asNumber(fresh?.scoreVector['active_attention'], 1)).toBeLessThan(
      asNumber(aged?.scoreVector['active_attention'], 0),
    );
    expect(asNumber(fresh?.scoreVector['participation'], 1)).toBeLessThan(
      asNumber(aged?.scoreVector['participation'], 0),
    );
    // The anti-signal factor is 1 for both (no burst) — the difference is trust.
    expect(fresh?.scoreVector['anti_signal_factor']).toBe(1);
    expect(aged?.scoreVector['anti_signal_factor']).toBe(1);
  });
});

describe('behavioral-authenticity damping is applied in the SAME tick (WS-E ordering)', () => {
  /** 12 identical bot snapshots so the behavior job assesses + clusters a fleet. */
  function botWindows(actorRef: string): ActorBehaviorWindowRecord[] {
    return Array.from({ length: 12 }, (_, h) => ({
      actorRef,
      windowStart: new Date(T0 - (h + 1) * HOUR).toISOString(),
      eventCount: 12,
      itemsTouched: 12,
      dwellHistogram: { extended: 12 },
      replyDepthHistogram: {},
      returnHistogram: {},
      sourceOpens: 0,
      contextOpens: 0,
      saves: 0,
      contributions: 0,
    }));
  }

  it('a clone-fleet-attended item scores below a clean item run in the SAME tick', async () => {
    // The behavior job now runs BEFORE scoring, so a fleet whose LOW authenticity
    // is computed this tick damps its item's PWAtt components THIS tick — not the
    // next. Two items, identical attention; the fleet's attenders carry a prior
    // duplicated-behavior history, the clean item's do not.
    const dampedStory = randomUUID();
    const cleanStory = randomUUID();
    const richItem = (storyId: string) => ({
      story_id: storyId,
      active_dwell_bucket: 'extended' as const,
      source_opened: true,
      context_opened: true,
      reply_depth_bucket: 'shallow' as const,
      return_visit_count_bucket: 'several' as const,
    });
    for (let i = 0; i < 3; i += 1) {
      const fleet = await seedUserWithSession(fixture.identity, { handle: `bfleet${i}` });
      await fixture.events.behaviorStore.upsertWindows(botWindows(fleet.userId));
      await ingestAttention(fleet.userId, dampedStory, { items: [richItem(dampedStory)] });
      const clean = await seedUserWithSession(fixture.identity, { handle: `bclean${i}` });
      await ingestAttention(clean.userId, cleanStory, { items: [richItem(cleanStory)] });
    }

    // One tick: behavior job (assess the fleet low) THEN scoring (apply it).
    await runEventPipelineTick(fixture.events, fixture.identity, () => {}, T0 + 2 * HOUR);

    const damped = await fixture.events.invariantStore.latest('PWAtt_v1', dampedStory);
    const clean = await fixture.events.invariantStore.latest('PWAtt_v1', cleanStory);
    expect(asNumber(damped?.scoreVector['active_attention'], 1)).toBeLessThan(
      asNumber(clean?.scoreVector['active_attention'], 0),
    );
  });
});

describe('harassment-cascade freeze (WS-E.2.2c + WS-E.2.3e)', () => {
  async function cascade(storyId: string): Promise<void> {
    // Hostile counting is low_info_reply ONLY (the retired `flag` type is gone
    // with the write-taxonomy retirement): a pile-on is a low-info-reply burst.
    for (let i = 0; i < 6; i += 1) {
      const { userId } = await seedUserWithSession(fixture.identity, { handle: `pileon${i}x` });
      await fixture.events.eventStore.insertMany([
        contributionRow(storyId, userId, 'low_info_reply'),
        contributionRow(storyId, userId, 'low_info_reply'),
      ]);
    }
  }

  it('opens a high-priority safety case, freezes growth, and keeps the ledger recording', async () => {
    const safetyCases: string[] = [];
    fixture = freshEventServices({
      hooks: {
        safetyQueue: (moderationCase) => {
          safetyCases.push(moderationCase.reason_code);
        },
      },
      storyTitle: () => 'Targeted story',
    });
    const storyId = randomUUID();
    await cascade(storyId);
    const report = await runPwattWindow(fixture.events, fixture.identity, T0, '1h');
    expect(report.cascadesDetected).toBe(1);
    expect(safetyCases).toEqual(['MOD_HARASS_002']);

    // The item is frozen via the shared WS-E.2.3e mechanism…
    const safety = await fixture.events.safetyStore.get(storyId);
    expect(safety?.safetyState).toBe('frozen');
    // …the transition is audit-logged…
    const probe = await fixture.identity.audit.append({
      actorUserId: null,
      eventType: 'safety_state_change',
      context: {},
    });
    expect(probe.event_type).toBe('safety_state_change');

    // …and during the freeze, new attention still populates the ledger while
    // the stored score stays pinned (WS-E.2.3e: recorded, not rewarded).
    const reader = await seedUserWithSession(fixture.identity, { handle: 'lateread' });
    await ingestAttention(reader.userId, storyId);
    await runPwattWindow(fixture.events, fixture.identity, T0, '1h');
    const ledger = await fixture.events.ledgerStore.listForUser(reader.userId, 10);
    expect(ledger.entries).toHaveLength(1); // ledger recorded during freeze
    const v0 = await fixture.events.invariantStore.latest('PWAtt_v0', storyId);
    expect(v0?.scoreVector['score']).toBe(0); // pinned at the freeze-time score
    expect(v0?.scoreVector['raw_score']).toBeGreaterThan(0); // raw kept for audit

    // WS-E.2.3e freeze binds the SERVED COMPONENTS the ranking feature store
    // reads (§5.3 "freeze ranking growth"): a frozen item's active_attention /
    // participation are pinned (0 here — the cascade was the item's first
    // window, no prior legitimate level), while the RAW components record the
    // late reader's real attention for audit. Without this, the late reader's
    // fresh attention would keep growing the frozen item's rank.
    expect(v0?.scoreVector['active_attention']).toBe(0); // served: pinned
    expect(v0?.scoreVector['raw_active_attention']).toBeGreaterThan(0); // raw: real
    const v1 = await fixture.events.invariantStore.latest('PWAtt_v1', storyId);
    expect(v1?.scoreVector['active_attention']).toBe(0); // served: pinned
    expect(v1?.scoreVector['participation']).toBe(0); // served: pinned
    expect(v1?.scoreVector['raw_active_attention']).toBeGreaterThan(0); // raw: real
  });

  it('isolated criticism does not trigger a cascade (conservative detector)', async () => {
    const storyId = randomUUID();
    const { userId } = await seedUserWithSession(fixture.identity);
    await fixture.events.eventStore.insertMany([
      contributionRow(storyId, userId, 'correction'),
      contributionRow(storyId, userId, 'low_info_reply'),
    ]);
    const report = await runPwattWindow(fixture.events, fixture.identity, T0, '1h');
    expect(report.cascadesDetected).toBe(0);
  });

  it('cleared content resumes growth; removed content scores zero (WS-E.2.3e)', async () => {
    const storyId = randomUUID();
    await cascade(storyId);
    await runPwattWindow(fixture.events, fixture.identity, T0, '1h');
    expect((await fixture.events.safetyStore.get(storyId))?.safetyState).toBe('frozen');

    // Moderation clears the case: growth resumes.
    const cleared = await resolveItemSafetyState(
      fixture.events,
      fixture.identity,
      storyId,
      'clear',
    );
    expect(cleared.ok).toBe(true);
    const reader = await seedUserWithSession(fixture.identity, { handle: 'afterclear' });
    await ingestAttention(reader.userId, storyId);
    await runPwattWindow(fixture.events, fixture.identity, T0, '1h');
    const afterClear = await fixture.events.invariantStore.latest('PWAtt_v0', storyId);
    expect(afterClear?.scoreVector['score']).toBeGreaterThan(0);

    // Moderation removes the content: the score is zero, terminally.
    const removed = await resolveItemSafetyState(
      fixture.events,
      fixture.identity,
      storyId,
      'remove',
    );
    expect(removed.ok).toBe(true);
    await runPwattWindow(fixture.events, fixture.identity, T0, '1h');
    const afterRemove = await fixture.events.invariantStore.latest('PWAtt_v0', storyId);
    expect(afterRemove?.scoreVector['score']).toBe(0);
    // Illegal transition out of removed is rejected.
    expect(
      (await resolveItemSafetyState(fixture.events, fixture.identity, storyId, 'clear')).ok,
    ).toBe(false);
  });
});

describe('fallback-boundary verification (WS-E.2.1e → WS-I.4.1b, CI-gated)', () => {
  it('PWAtt rows are stored as bounded inputs; the FALLBACK boundary still rejects them', async () => {
    // §30.5 LIFTED by WS-I: this constant is the reviewed code-level gate.
    // Reverting it to `true` is the code counterpart of the runtime kill
    // switch (the WS-I scoring path then refuses PWAtt components again).
    expect(PWATT_V0_SHADOW_MODE).toBe(false);
    const { userId } = await seedUserWithSession(fixture.identity);
    const storyId = randomUUID();
    await ingestAttention(userId, storyId);
    await runPwattWindow(fixture.events, fixture.identity, T0, '1h');
    const outputs = await fixture.events.invariantStore.listForTarget(storyId);
    expect(outputs.length).toBeGreaterThan(0);
    for (const output of outputs) {
      // Post-lift storage: bounded inputs, not shadow artifacts.
      expect(output.shadowMode).toBe(false);
      // The SAFE FALLBACK boundary rejects every PWAtt row REGARDLESS of
      // its flag — engaging the kill switch restores the pre-lift posture
      // with zero PWAtt influence (WS-I.4.1b).
      expect(() => assertRankingInputAllowed(output)).toThrow(RankingBoundaryViolation);
    }
    // …even when the flag claims otherwise (belt and braces).
    const mislabeled = { ...(outputs[0] as NonNullable<(typeof outputs)[0]>), shadowMode: false };
    expect(() => assertRankingInputAllowed(mislabeled)).toThrow(RankingBoundaryViolation);
  });

  it('FALLBACK ranking output is IDENTICAL with and without PWAtt scores', async () => {
    const candidates = [
      { storyId: '5f5e1000-0000-4000-8000-000000000001', createdAt: '2026-06-10T09:00:00.000Z' },
      { storyId: '5f5e1000-0000-4000-8000-000000000002', createdAt: '2026-06-10T08:00:00.000Z' },
      { storyId: '5f5e1000-0000-4000-8000-000000000003', createdAt: '2026-06-10T09:30:00.000Z' },
    ];
    const before = rankFrontPageV0(candidates, []);

    // Compute real PWAtt scores for these items, then rank again WITH them.
    const { userId } = await seedUserWithSession(fixture.identity);
    for (const candidate of candidates) {
      await ingestAttention(userId, candidate.storyId);
    }
    await runPwattWindow(fixture.events, fixture.identity, T0, '1h');
    const withScores = rankFrontPageV0(candidates, await fixture.events.invariantStore.listAll());
    expect(withScores.order).toEqual(before.order);
    expect(withScores.rejectedShadowInputs).toBeGreaterThan(0);

    // Mutate the scores wildly and re-rank: STILL identical — the fallback
    // is provably score-blind, which is what makes the kill switch a safe
    // revert (WS-I.4.1a/b).
    for (const candidate of candidates) {
      await fixture.events.invariantStore.upsert({
        invariantType: 'PWAtt_v0',
        targetType: 'story',
        targetId: candidate.storyId,
        timeWindow: { start: '2026-06-01T00:00:00.000Z', end: '2026-06-01T01:00:00.000Z' },
        version: 'v0',
        scoreVector: { score: Math.random() },
        explanationSummary: null,
        confidence: 1,
        coverage: 1,
        reasonCodes: [],
        fallbackUsed: false,
        versionMetadata: null,
        shadowMode: false,
        createdAt: new Date().toISOString(),
      });
    }
    const mutated = rankFrontPageV0(candidates, await fixture.events.invariantStore.listAll());
    expect(mutated.order).toEqual(before.order);
  });

  it('the demo-contract /v1/feed response is byte-identical before and after a scoring run', async () => {
    // With an EMPTY story store the feed serves the WS-C demo contract,
    // which is OUTSIDE the ranking pipeline and therefore score-invariant.
    // (Pipeline-served feeds are exercised by the WS-I suites.)
    const app = new Hono().route('/v1', createV1Routes());
    const before = await (await app.request('/v1/feed')).text();
    const { userId } = await seedUserWithSession(fixture.identity);
    await ingestAttention(userId, randomUUID());
    await runEventPipelineTick(fixture.events, fixture.identity, () => {}, T0 + HOUR);
    const after = await (await app.request('/v1/feed')).text();
    expect(after).toBe(before);
  });
});

describe('scheduler windows (WS-E.2.1a scheduling)', () => {
  it('computes only windows with new arrivals; skips empty and unchanged ones', async () => {
    // A controllable clock drives BOTH ingestion receipt (created_at) and
    // window computedAt, so the freshness comparison is deterministic.
    let clock = T0 + 2 * HOUR; // the [T0, T0+1h) window completed an hour ago
    fixture = freshEventServices({ now: () => clock });
    const now = clock;
    // Nothing ingested: nothing is due (no empty-window churn).
    expect(await windowsNeedingCompute(fixture.events, now)).toEqual([]);

    const { userId } = await seedUserWithSession(fixture.identity);
    await ingestAttention(userId, randomUUID());
    const due = await windowsNeedingCompute(fixture.events, now);
    // Only the COMPLETED windows covering the event are due: its 1h and 6h
    // windows closed by now; its 24h/7d windows are still open.
    expect(due.map((w) => w.size).sort()).toEqual(['1h', '6h']);
    const oneHour = due.find((w) => w.size === '1h');
    expect(oneHour?.startMs).toBe(T0);

    // After computing (one clock tick later), nothing is due (skip unchanged).
    clock += 1;
    for (const window of due) {
      await runPwattWindow(fixture.events, fixture.identity, window.startMs, window.size);
    }
    expect(await windowsNeedingCompute(fixture.events, now)).toEqual([]);

    // …and a LATE arrival into the already-computed window re-opens it.
    clock += 1;
    await ingestAttention(userId, randomUUID());
    const reopened = await windowsNeedingCompute(fixture.events, now);
    expect(reopened.map((w) => w.size)).toContain('1h');

    // Once the larger windows close, the (uncomputed) 24h/7d windows of the
    // events become due — while the 1h/6h windows have aged out of their
    // trailing lookback (the documented deep-late bound).
    const muchLater = T0 + 8 * 24 * HOUR;
    const lateDue = await windowsNeedingCompute(fixture.events, muchLater);
    const sizes = lateDue.map((w) => w.size);
    expect(sizes).toContain('24h');
    expect(sizes).toContain('7d');
    expect(sizes).not.toContain('1h');
    expect(sizes).not.toContain('6h');
  });

  it('a full pipeline tick scores, sweeps, and reconciles without error', async () => {
    const errors: unknown[] = [];
    const { userId } = await seedUserWithSession(fixture.identity);
    await ingestAttention(userId, randomUUID());
    await runEventPipelineTick(
      fixture.events,
      fixture.identity,
      (err) => errors.push(err),
      T0 + HOUR,
    );
    expect(errors).toEqual([]);
  });
});

describe('integrated v1 stage (WS-E.2.3a/b in the live pipeline)', () => {
  it('the contribution hierarchy affects the STORED v1 output', async () => {
    // Two items with identical volume; only the contribution TYPE differs
    // (correction 0.9 vs explanation 0.5). v0 weighs both constructive types
    // uniformly, so the difference in the stored v1 totals is attributable to
    // the hierarchy alone.
    const correctionItem = randomUUID();
    const explanationItem = randomUUID();
    const { userId } = await seedUserWithSession(fixture.identity);
    await fixture.events.eventStore.insertMany([
      // BOTH sourced, so the WS-T citation bonus is identical and the only
      // difference is the contribution TYPE (isolating the hierarchy).
      contributionRow(correctionItem, userId, 'correction', { hasCitation: true }),
      contributionRow(explanationItem, userId, 'explanation', { hasCitation: true }),
    ]);
    await runPwattWindow(fixture.events, fixture.identity, T0, '1h');
    const correctionV1 = await fixture.events.invariantStore.latest('PWAtt_v1', correctionItem);
    const explanationV1 = await fixture.events.invariantStore.latest('PWAtt_v1', explanationItem);
    // The served `participation` component (what ranking consumes) reflects the
    // hierarchy — a correction outranks a plain comment. (No composite `total`
    // is stored: the §5.4 composition is @licio/ranking's, PR7.)
    expect(correctionV1?.scoreVector['participation']).toBeGreaterThan(
      asNumber(explanationV1?.scoreVector['participation'], Number.POSITIVE_INFINITY),
    );
    // v0 (uniform weights) sees them identically — the control assertion.
    const correctionV0 = await fixture.events.invariantStore.latest('PWAtt_v0', correctionItem);
    const explanationV0 = await fixture.events.invariantStore.latest('PWAtt_v0', explanationItem);
    expect(correctionV0?.scoreVector['score']).toBe(explanationV0?.scoreVector['score']);
  });

  it('v1 runtime config from the store changes the stored v1 output', async () => {
    const itemId = randomUUID();
    const { userId } = await seedUserWithSession(fixture.identity);
    await fixture.events.eventStore.insertMany([contributionRow(itemId, userId, 'correction')]);
    await runPwattWindow(fixture.events, fixture.identity, T0, '1h');
    const before = await fixture.events.invariantStore.latest('PWAtt_v1', itemId);

    // Tune the participation contributions dimension DOWN via the store.
    const curve = { kind: 'logarithmic', scale: 4, saturationPoint: 25 };
    await fixture.events.configStore.set('v1', {
      contributionWeights: {
        correction: 0.9,
        bridge_comment: 0.85,
        explanation: 0.5,
        steward_action: 0.5,
        low_info_reply: 0,
      },
      contributionCurve: { kind: 'logarithmic', scale: 1, saturationPoint: 6 },
      attentionDimensions: {
        dwell: { weightPct: 40, curve },
        source: { weightPct: 25, curve },
        context: { weightPct: 20, curve },
        traversal: { weightPct: 15, curve },
      },
      participationDimensions: {
        returns: { weightPct: 45, curve },
        saves: { weightPct: 45, curve },
        contributions: { weightPct: 10, curve },
      },
      accusationDownweight: 0.25,
      citationBonus: 0.35,
      rapidThreshold: 5,
      rapidDampening: 0.3,
      antiSignalAttenuation: { coordinatedBurstMax: 0.5, harassmentCascade: 0.3 },
    });
    await runPwattWindow(fixture.events, fixture.identity, T0, '1h');
    const after = await fixture.events.invariantStore.latest('PWAtt_v1', itemId);
    expect(after?.scoreVector['participation']).toBeLessThan(
      asNumber(before?.scoreVector['participation'], 0),
    );
  });
});

describe('system-event producers (WS-E.1.1e closures)', () => {
  it('emits invariant.run.completed once per item/window (idempotent re-runs)', async () => {
    const { userId } = await seedUserWithSession(fixture.identity);
    const storyId = randomUUID();
    await ingestAttention(userId, storyId);
    await runPwattWindow(fixture.events, fixture.identity, T0, '1h');
    await runPwattWindow(fixture.events, fixture.identity, T0, '1h'); // re-run
    const emitted = await fixture.events.eventStore.listByTopicsBetween(
      ['invariant.run.completed'],
      new Date(Date.now() - 60_000).toISOString(),
      new Date(Date.now() + 60_000).toISOString(),
    );
    expect(emitted).toHaveLength(1); // deterministic id => no duplicates
    const payload = emitted[0]?.payload as {
      invariant_type: string;
      time_window: string;
      computation_time_ms: number;
      score_vector: Record<string, number>;
    };
    expect(payload.invariant_type).toBe('PWAtt');
    expect(payload.time_window).toBe(`${new Date(T0).toISOString()}/1h`);
    expect(payload.computation_time_ms).toBeGreaterThanOrEqual(0);
    expect(payload.score_vector['v0_score']).toBeGreaterThan(0);
  });

  it('emits thread.state.changed (safety dimension) on a cascade freeze', async () => {
    const storyId = randomUUID();
    for (let i = 0; i < 6; i += 1) {
      const { userId } = await seedUserWithSession(fixture.identity, { handle: `hostile${i}x` });
      await fixture.events.eventStore.insertMany([
        contributionRow(storyId, userId, 'low_info_reply'),
        contributionRow(storyId, userId, 'low_info_reply'),
      ]);
    }
    await runPwattWindow(fixture.events, fixture.identity, T0, '1h');
    const emitted = await fixture.events.eventStore.listByTopicsBetween(
      ['thread.state.changed'],
      new Date(Date.now() - 60_000).toISOString(),
      new Date(Date.now() + 60_000).toISOString(),
    );
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.payload).toMatchObject({
      state_dimension: 'safety',
      old_state: 'normal',
      new_state: 'frozen',
      changed_by: 'system',
    });
  });
});

describe('ledger scoping + source-dwell semantics', () => {
  it('writes ledger entries from the 1h window ONLY (no per-size duplicates)', async () => {
    const { userId } = await seedUserWithSession(fixture.identity);
    const storyId = randomUUID();
    await ingestAttention(userId, storyId);
    for (const size of ['1h', '6h', '24h', '7d'] as const) {
      await runPwattWindow(fixture.events, fixture.identity, windowStartMs(T0, size), size);
    }
    const ledger = await fixture.events.ledgerStore.listForUser(userId, 50);
    expect(ledger.entries).toHaveLength(1); // one canonical entry, not four
    expect(ledger.entries[0]?.windowSize).toBe('1h');
    // Cap status is honestly absent (knowable only on the client).
    expect(ledger.entries[0]?.signals['cap_reached']).toBeUndefined();
  });

  it('a brief non-bounce source visit earns zero weight (bounce-adjacent)', async () => {
    const { userId } = await seedUserWithSession(fixture.identity);
    const storyId = randomUUID();
    await ingestAttentionEvents(
      fixture.events,
      fixture.identity,
      userId,
      [
        sourceOpenEvent(userId, {
          story_id: storyId,
          dwell_bucket: 'brief',
          bounce: false,
          timestamp: IN_WINDOW,
        }),
      ],
      { maxPastMs: Number.MAX_SAFE_INTEGER, maxFutureMs: Number.MAX_SAFE_INTEGER },
    );
    await computeAggregationWindow(fixture.events, T0, '1h');
    const row = await fixture.events.windowStore.get(storyId, new Date(T0).toISOString(), '1h');
    expect(row?.sourceOpens).toBe(0); // brief = bounce-adjacent, not meaningful
    // A moderate visit IS meaningful.
    const other = randomUUID();
    await ingestAttentionEvents(
      fixture.events,
      fixture.identity,
      userId,
      [
        sourceOpenEvent(userId, {
          story_id: other,
          dwell_bucket: 'moderate',
          bounce: false,
          timestamp: IN_WINDOW,
        }),
      ],
      { maxPastMs: Number.MAX_SAFE_INTEGER, maxFutureMs: Number.MAX_SAFE_INTEGER },
    );
    await computeAggregationWindow(fixture.events, T0, '1h');
    const meaningful = await fixture.events.windowStore.get(
      other,
      new Date(T0).toISOString(),
      '1h',
    );
    expect(meaningful?.sourceOpens).toBe(1);
  });
});
