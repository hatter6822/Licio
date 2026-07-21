// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Bot-prevention layer 2, operational side (pwatt/behavior.ts): the per-actor
// snapshot fold inside the window run (privacy bucket never profiled;
// idempotent re-scores), the hourly authenticity job (coherence + MinHash
// duplication clustering, deterministic cluster ids, retention pruning), and
// the served-score damping through the PWAtt trust factor.
import { randomUUID } from 'node:crypto';
import { DEFAULT_BEHAVIOR_AUTHENTICITY_CONFIG } from '@licio/invariants';
import { beforeEach, describe, expect, it } from 'vitest';
import { ingestAttentionEvents } from '../events/ingest.js';
import { purgeUserAttention } from '../events/retention.js';
import { type ActorBehaviorWindowRecord, PSEUDONYMOUS_USER_ID } from '../events/stores.js';
import { BEHAVIOR_WINDOW_RETENTION_MS, runBehaviorAuthenticityJob } from '../pwatt/behavior.js';
import { runPwattWindow } from '../pwatt/scoring.js';
import {
  attentionEvent,
  type EventServicesFixture,
  freshEventServices,
  seedUserWithSession,
} from './event-test-helpers.js';

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 5, 10, 10, 0, 0);
const IN_WINDOW = new Date(T0 + 10 * 60_000).toISOString();
const CONFIG = DEFAULT_BEHAVIOR_AUTHENTICITY_CONFIG;

let fixture: EventServicesFixture;

beforeEach(() => {
  fixture = freshEventServices({ storyTitle: () => 'Water main study' });
});

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

/** A degenerate bot snapshot at hour offset `h` for `actorRef`. */
function botWindow(actorRef: string, h: number): ActorBehaviorWindowRecord {
  return {
    actorRef,
    windowStart: new Date(T0 + h * HOUR).toISOString(),
    eventCount: 12,
    itemsTouched: 12,
    dwellHistogram: { extended: 12 },
    replyDepthHistogram: {},
    returnHistogram: {},
    sourceOpens: 0,
    contextOpens: 0,
    saves: 0,
    contributions: 0,
  };
}

/** A plausibly-human snapshot: bursty, varied, multi-dimensional. */
function humanWindow(actorRef: string, i: number): ActorBehaviorWindowRecord {
  const dwellMix = [
    { glance: 3, short: 1 },
    { short: 2, medium: 2 },
    { medium: 1, long: 1 },
    { glance: 1, extended: 1 },
  ];
  return {
    actorRef,
    windowStart: new Date(T0 + (i * 5 + (i % 3)) * HOUR).toISOString(),
    eventCount: 2 + (i % 5) * 3,
    itemsTouched: 3,
    dwellHistogram: dwellMix[i % dwellMix.length] as Record<string, number>,
    replyDepthHistogram: i % 4 === 0 ? { shallow: 1 } : {},
    returnHistogram: i % 5 === 0 ? { few: 1 } : {},
    sourceOpens: i % 4 === 0 ? 1 : 0,
    contextOpens: i % 6 === 0 ? 1 : 0,
    saves: 0,
    contributions: i % 7 === 0 ? 1 : 0,
  };
}

describe('behavior snapshot fold inside the window run', () => {
  it('persists ONE per-actor snapshot on the 1h run, skipping the privacy bucket', async () => {
    const user = await seedUserWithSession(fixture.identity);
    const storyA = randomUUID();
    const storyB = randomUUID();
    await ingestAttention(user.userId, storyA);
    await ingestAttention(user.userId, storyB, {
      items: [
        {
          story_id: storyB,
          active_dwell_bucket: 'long',
          source_opened: false,
          context_opened: true,
          reply_depth_bucket: 'none',
          return_visit_count_bucket: 'few',
        },
      ],
    });
    // A minimum-privacy reader folds into the coarse bucket actor — profiled NEVER.
    await ingestAttentionEvents(
      fixture.events,
      fixture.identity,
      user.userId,
      [
        attentionEvent(user.userId, {
          storyId: storyA,
          timestamp: IN_WINDOW,
          privacy_level: 'minimum',
        }),
      ],
      { maxPastMs: Number.MAX_SAFE_INTEGER, maxFutureMs: Number.MAX_SAFE_INTEGER },
    );

    await runPwattWindow(fixture.events, fixture.identity, T0, '1h');
    const snapshots = await fixture.events.behaviorStore.listWindowsSince(
      new Date(0).toISOString(),
    );
    expect(snapshots).toHaveLength(1); // the identifiable actor only
    const snapshot = snapshots[0] as ActorBehaviorWindowRecord;
    expect(snapshot.actorRef).toBe(user.userId);
    expect(snapshot.itemsTouched).toBe(2);
    expect(snapshot.dwellHistogram['medium']).toBe(1);
    expect(snapshot.dwellHistogram['long']).toBe(1);
    expect(snapshot.sourceOpens).toBe(1);
    expect(snapshot.contextOpens).toBe(1);

    // Idempotent: a re-score converges to the same single snapshot.
    await runPwattWindow(fixture.events, fixture.identity, T0, '1h');
    const again = await fixture.events.behaviorStore.listWindowsSince(new Date(0).toISOString());
    expect(again).toHaveLength(1);
    expect((again[0] as ActorBehaviorWindowRecord).eventCount).toBe(snapshot.eventCount);

    // The 6h/24h/7d sizes do NOT write snapshots (1h is the canonical grain).
    await runPwattWindow(fixture.events, fixture.identity, T0, '6h');
    expect(
      await fixture.events.behaviorStore.listWindowsSince(new Date(0).toISOString()),
    ).toHaveLength(1);
  });
});

describe('runBehaviorAuthenticityJob (assessment + duplication clustering)', () => {
  it('clusters clone fleets, damps them, leaves the human neutral — deterministically', async () => {
    const clones = ['clone-a', 'clone-b', 'clone-c'].map(() => randomUUID());
    const human = randomUUID();
    const windows: ActorBehaviorWindowRecord[] = [];
    for (const clone of clones) {
      for (let h = 0; h < 72; h += 1) windows.push(botWindow(clone, h));
    }
    for (let i = 0; i < 60; i += 1) windows.push(humanWindow(human, i));
    await fixture.events.behaviorStore.upsertWindows(windows);

    const nowMs = T0 + 73 * HOUR;
    const report = await runBehaviorAuthenticityJob(fixture.events, CONFIG, nowMs);
    expect(report.actorsAssessed).toBe(4);
    expect(report.clusterCount).toBe(1);
    expect(report.largestClusterSize).toBe(3);

    const humanScore = await fixture.events.behaviorStore.getAuthenticity(human);
    expect(humanScore?.score).toBe(1);
    expect(humanScore?.clusterId).toBeNull();

    const cloneScores = await Promise.all(
      clones.map((c) => fixture.events.behaviorStore.getAuthenticity(c)),
    );
    for (const score of cloneScores) {
      expect(score?.clusterSize).toBe(3);
      expect(score?.flags).toContain('behavior_duplication');
      // coherence floor (0.25) × duplication (1/3), floored at overallFloor.
      expect(score?.score).toBeCloseTo(
        Math.max(CONFIG.overallFloor, CONFIG.componentFloor / 3),
        10,
      );
    }
    // Deterministic cluster identity: every member shares it, and a re-run
    // reproduces it exactly.
    const clusterIds = new Set(cloneScores.map((s) => s?.clusterId));
    expect(clusterIds.size).toBe(1);
    await runBehaviorAuthenticityJob(fixture.events, CONFIG, nowMs);
    const rerun = await fixture.events.behaviorStore.getAuthenticity(clones[0] as string);
    expect(rerun?.clusterId).toBe(cloneScores[0]?.clusterId);
  });

  it('prunes snapshots past the retention horizon', async () => {
    const actor = randomUUID();
    const stale: ActorBehaviorWindowRecord = {
      ...botWindow(actor, 0),
      windowStart: new Date(T0 - BEHAVIOR_WINDOW_RETENTION_MS - HOUR).toISOString(),
    };
    await fixture.events.behaviorStore.upsertWindows([stale, botWindow(actor, 0)]);
    await runBehaviorAuthenticityJob(fixture.events, CONFIG, T0 + HOUR);
    const remaining = await fixture.events.behaviorStore.listWindowsSince(
      new Date(0).toISOString(),
    );
    expect(remaining).toHaveLength(1);
    expect((remaining[0] as ActorBehaviorWindowRecord).windowStart).toBe(
      botWindow(actor, 0).windowStart,
    );
  });

  it('prunes the assessment of a fully-dormant actor (population stays fresh)', async () => {
    // A dormant actor with an OLD assessment and no recent windows; an active
    // actor with a fresh window. The job re-assesses only the active actor and
    // prunes the dormant assessment past the retention horizon.
    const dormant = randomUUID();
    const active = randomUUID();
    await fixture.events.behaviorStore.upsertAuthenticity([
      {
        actorRef: dormant,
        score: 0.25,
        coherence: 0.25,
        components: { dwell_variety: 0.25, interaction_breadth: 1, temporal_rhythm: 1 },
        flags: ['dwell_variety'],
        evidence: 500,
        clusterId: null,
        clusterSize: 1,
        computedAt: new Date(T0 - BEHAVIOR_WINDOW_RETENTION_MS - HOUR).toISOString(),
      },
    ]);
    await fixture.events.behaviorStore.upsertWindows([botWindow(active, 0)]);
    await runBehaviorAuthenticityJob(fixture.events, CONFIG, T0 + HOUR);
    expect(await fixture.events.behaviorStore.getAuthenticity(dormant)).toBeNull();
    expect(await fixture.events.behaviorStore.getAuthenticity(active)).not.toBeNull();
  });

  it('does NOT cluster a duplicate stream below MIN_SIGNATURE_WINDOWS', async () => {
    // 3 identical clones, but only 8 active windows each (< 12): too little
    // sustained shared shape to enter signature clustering.
    const clones = ['s1', 's2', 's3'].map(() => randomUUID());
    const windows: ActorBehaviorWindowRecord[] = [];
    for (const clone of clones) {
      for (let h = 0; h < 8; h += 1) windows.push(botWindow(clone, h));
    }
    await fixture.events.behaviorStore.upsertWindows(windows);
    const report = await runBehaviorAuthenticityJob(fixture.events, CONFIG, T0 + 9 * HOUR);
    expect(report.clusterCount).toBe(0);
    for (const clone of clones) {
      const s = await fixture.events.behaviorStore.getAuthenticity(clone);
      expect(s?.clusterSize).toBe(1);
      expect(s?.flags ?? []).not.toContain('behavior_duplication');
    }
  });

  it('does NOT cluster two similar-but-sub-threshold streams', async () => {
    // Two eligible actors whose streams share shape for most windows but differ
    // enough that the verified Jaccard stays below the duplication threshold —
    // an LSH candidate pair that fails verification is never merged.
    const a = randomUUID();
    const b = randomUUID();
    const windows: ActorBehaviorWindowRecord[] = [];
    for (let h = 0; h < 60; h += 1) {
      windows.push(botWindow(a, h));
      // b diverges on a third of its windows (distinct contribution/source shape).
      windows.push(
        h % 3 === 0
          ? {
              ...botWindow(b, h),
              eventCount: 5,
              itemsTouched: 5,
              dwellHistogram: { glance: 3, short: 2 },
              sourceOpens: 2,
              contributions: 1,
            }
          : botWindow(b, h),
      );
    }
    await fixture.events.behaviorStore.upsertWindows(windows);
    const report = await runBehaviorAuthenticityJob(fixture.events, CONFIG, T0 + 61 * HOUR);
    expect(report.clusterCount).toBe(0);
    expect((await fixture.events.behaviorStore.getAuthenticity(a))?.clusterSize).toBe(1);
    expect((await fixture.events.behaviorStore.getAuthenticity(b))?.clusterSize).toBe(1);
  });

  it('never assesses quiet actors below the evidence floors as anything but neutral', async () => {
    const lurker = randomUUID();
    await fixture.events.behaviorStore.upsertWindows([
      { ...botWindow(lurker, 0), eventCount: 2, itemsTouched: 2, dwellHistogram: { extended: 2 } },
    ]);
    await runBehaviorAuthenticityJob(fixture.events, CONFIG, T0 + HOUR);
    const score = await fixture.events.behaviorStore.getAuthenticity(lurker);
    expect(score?.score).toBe(1);
    expect(score?.flags).toEqual([]);
  });
});

describe('authenticity damps the served PWAtt trust factor', () => {
  it('an assessed low-authenticity actor earns lower served v1 components than an identical neutral actor', async () => {
    const damped = await seedUserWithSession(fixture.identity);
    const neutral = await seedUserWithSession(fixture.identity);
    await fixture.events.behaviorStore.upsertAuthenticity([
      {
        actorRef: damped.userId,
        score: 0.25,
        coherence: 0.25,
        components: { dwell_variety: 0.25, interaction_breadth: 1, temporal_rhythm: 1 },
        flags: ['dwell_variety'],
        evidence: 500,
        clusterId: null,
        clusterSize: 1,
        computedAt: new Date(T0).toISOString(),
      },
    ]);
    const storyDamped = randomUUID();
    const storyNeutral = randomUUID();
    await ingestAttention(damped.userId, storyDamped);
    await ingestAttention(neutral.userId, storyNeutral);

    await runPwattWindow(fixture.events, fixture.identity, T0, '1h');
    const dampedRow = await fixture.events.invariantStore.latest('PWAtt_v1', storyDamped);
    const neutralRow = await fixture.events.invariantStore.latest('PWAtt_v1', storyNeutral);
    const dampedAttention = dampedRow?.scoreVector['raw_active_attention'] as number;
    const neutralAttention = neutralRow?.scoreVector['raw_active_attention'] as number;
    expect(dampedAttention).toBeGreaterThan(0); // damped, never silenced
    expect(dampedAttention).toBeLessThan(neutralAttention);
  });

  it('an unassessed actor is exactly neutral (no record ⇒ factor 1)', async () => {
    const a = await seedUserWithSession(fixture.identity);
    const b = await seedUserWithSession(fixture.identity);
    const storyA = randomUUID();
    const storyB = randomUUID();
    await ingestAttention(a.userId, storyA);
    await ingestAttention(b.userId, storyB);
    await runPwattWindow(fixture.events, fixture.identity, T0, '1h');
    const rowA = await fixture.events.invariantStore.latest('PWAtt_v1', storyA);
    const rowB = await fixture.events.invariantStore.latest('PWAtt_v1', storyB);
    expect(rowA?.scoreVector['raw_active_attention']).toBe(
      rowB?.scoreVector['raw_active_attention'],
    );
  });
});

describe('deletion pseudonym is never profiled', () => {
  it('the fold skips a contribution folded under the deletion pseudonym', async () => {
    // A deleted account's surviving public contribution is anonymized to the
    // PSEUDONYMOUS_USER_ID actor. The pseudonym has NO users row, so folding it
    // would violate the production actor_ref FK — it MUST be skipped alongside
    // the privacy bucket. A real reader in the same window is folded as usual.
    const reader = await seedUserWithSession(fixture.identity);
    const storyId = randomUUID();
    const threadId = storyId; // v0 maps thread 1:1 to story
    await ingestAttention(reader.userId, storyId);
    await fixture.events.eventStore.insertMany([
      {
        eventId: randomUUID(),
        eventType: 'contribution.created',
        topic: 'contribution.created',
        timestamp: IN_WINDOW,
        privacyClassification: 'public',
        retentionTier: 'public_contribution',
        payload: {
          event_id: randomUUID(),
          event_type: 'contribution.created',
          timestamp: IN_WINDOW,
          schema_version: '1',
          contribution_id: randomUUID(),
          thread_id: threadId,
          user_id: PSEUDONYMOUS_USER_ID,
          contribution_type: 'low_info_reply',
          target_claim_id: null,
          parent_contribution_id: null,
          has_citation: false,
          accusation_flag: false,
          privacy_classification: 'public',
          retention_tier: 'public_contribution',
        },
        ownerUserId: null,
        purgeAfter: null,
      },
    ]);

    // Must NOT throw (the in-memory store would accept the pseudonym silently,
    // but production's FK would reject it — the fold prevents it entirely).
    await runPwattWindow(fixture.events, fixture.identity, T0, '1h');
    const snapshots = await fixture.events.behaviorStore.listWindowsSince(
      new Date(0).toISOString(),
    );
    const actors = snapshots.map((s) => s.actorRef);
    expect(actors).toContain(reader.userId);
    expect(actors).not.toContain(PSEUDONYMOUS_USER_ID);
  });
});

describe('purgeUserAttention removes both behavior planes', () => {
  it('deletes an actor’s snapshots AND authenticity assessment', async () => {
    const user = await seedUserWithSession(fixture.identity);
    await ingestAttention(user.userId, randomUUID());
    await runPwattWindow(fixture.events, fixture.identity, T0, '1h');
    await runBehaviorAuthenticityJob(fixture.events, CONFIG, T0 + HOUR);
    // Both planes exist for the user before the purge.
    expect(
      (await fixture.events.behaviorStore.listWindowsSince(new Date(0).toISOString())).some(
        (w) => w.actorRef === user.userId,
      ),
    ).toBe(true);

    await purgeUserAttention(fixture.events, user.userId, 'delete');
    expect(await fixture.events.behaviorStore.getAuthenticity(user.userId)).toBeNull();
    expect(
      (await fixture.events.behaviorStore.listWindowsSince(new Date(0).toISOString())).some(
        (w) => w.actorRef === user.userId,
      ),
    ).toBe(false);
  });
});
