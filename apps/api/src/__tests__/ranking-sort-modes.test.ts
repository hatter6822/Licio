// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The SPEC §11.6 feed sort modes end-to-end: `best` is the ranked pipeline;
// `new` / `sources` / `debates` / `rising` are COMPLETE deterministic
// user-selected orderings over the same safety-filtered pool (logged
// `fallback: true, fallback_reason: 'user_mode'` with the honest
// `user_ordering`, carrying the ranked path's per-item feature row so the
// card posture agrees across surfaces, and never attributing the GWEI gate
// to a serve it did not shape). The legacy wire values (pre-redesign cached
// bundles) normalize per LEGACY_FEED_MODES: `balanced`→`best`,
// `chronological`→`new`, `low-personalization`→`new` (the non-personalized
// sort — the intent survives), and the removed pipeline modulations
// (`source-diverse` override, `local` quota boost) are gone. The kill switch
// outranks every mode.

import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { assembleFeatureVector, runFeatureBatch } from '../ranking/features.js';
import { engageKillSwitch } from '../ranking/killswitch.js';
import { serveFeed } from '../ranking/service.js';
import { seedUserWithSession } from './event-test-helpers.js';
import {
  freshRankingServices,
  promoteInvariant,
  type RankingFixture,
  seedInvariantOutput,
  seedStory,
} from './ranking-helpers.js';

let fixture: RankingFixture;

beforeEach(() => {
  fixture = freshRankingServices();
});

function featureDeps() {
  return {
    events: fixture.events,
    ingestion: fixture.ingestion,
    invariants: fixture.invariants,
    forum: fixture.forum,
    featureStore: fixture.ranking.featureStore,
    log: fixture.ranking.log,
    now: fixture.ranking.now,
  };
}

async function serve(mode: string | undefined, userId: string | null = null) {
  return serveFeed(fixture.ranking, {
    userId,
    surface: 'front_page',
    surfaceRoomId: null,
    surfaceTopicId: null,
    mode: mode as Parameters<typeof serveFeed>[1]['mode'],
  });
}

/** Insert one published contribution (optionally cited) directly. */
async function insertComment(threadId: string, opts: { cited?: boolean } = {}): Promise<string> {
  const id = randomUUID();
  await fixture.forum.contributions.insert({
    contributionId: id,
    threadId,
    userId: randomUUID(),
    type: 'comment',
    body: 'A substantive comment for the sort-mode tests.',
    citations: opts.cited === false ? [] : [{ url: `https://example.org/${id}` }],
    metadata: {},
    targetClaimId: null,
    parentContributionId: null,
    clientDraftId: `seed-${id}`,
    path: [],
    moderationState: 'published',
  });
  return id;
}

/** Two same-size PWAtt_v1 serving windows → a stored attention velocity. */
async function seedAttentionWindows(
  storyId: string,
  previousAttention: number,
  currentAttention: number,
): Promise<void> {
  await seedInvariantOutput(fixture.events, {
    invariantType: 'PWAtt_v1',
    targetId: storyId,
    scoreVector: { active_attention: previousAttention, participation: 0.5 },
    shadowMode: false,
    timeWindow: { start: '2026-06-10T00:00:00.000Z', end: '2026-06-10T01:00:00.000Z' },
    createdAt: '2026-06-10T01:00:05.000Z',
  });
  await seedInvariantOutput(fixture.events, {
    invariantType: 'PWAtt_v1',
    targetId: storyId,
    scoreVector: { active_attention: currentAttention, participation: 0.5 },
    shadowMode: false,
    timeWindow: { start: '2026-06-10T01:00:00.000Z', end: '2026-06-10T02:00:00.000Z' },
    createdAt: '2026-06-10T02:00:05.000Z',
  });
}

const HOUR = 3_600_000;

describe('feed sort modes (SPEC §11.6)', () => {
  it('`best` (and the default) serves the ranked pipeline', async () => {
    await seedStory(fixture.ingestion);
    for (const mode of ['best', undefined]) {
      const served = await serve(mode);
      expect(served.fallback).toBe(false);
      const log = await fixture.ranking.decisionLogs.getByRequestId(served.requestId);
      expect(log?.fallback).toBe(false);
      expect(log?.user_ordering).toBeNull();
    }
  });

  it('`new` serves strict time order with the honest user_ordering', async () => {
    const older = await seedStory(fixture.ingestion, {
      publishedAt: new Date(Date.now() - 2 * HOUR).toISOString(),
    });
    const newer = await seedStory(fixture.ingestion, {
      publishedAt: new Date(Date.now() - 1 * HOUR).toISOString(),
    });
    const served = await serve('new');
    expect(served.fallback).toBe(true);
    expect(served.items.map((i) => i.story_id)).toEqual([newer.storyId, older.storyId]);
    const log = await fixture.ranking.decisionLogs.getByRequestId(served.requestId);
    expect(log?.fallback_reason).toBe('user_mode');
    expect(log?.user_ordering).toBe('new');
  });

  it('`sources` orders by the published sourced-comment count, newest-first ties', async () => {
    // The newest story has NO sourced comments — chronological order would
    // put it first, proving the metric dominates the tie-break.
    const three = await seedStory(fixture.ingestion, {
      publishedAt: new Date(Date.now() - 3 * HOUR).toISOString(),
    });
    const one = await seedStory(fixture.ingestion, {
      publishedAt: new Date(Date.now() - 2 * HOUR).toISOString(),
    });
    const none = await seedStory(fixture.ingestion, {
      publishedAt: new Date(Date.now() - 1 * HOUR).toISOString(),
    });
    for (let i = 0; i < 3; i += 1) await insertComment(three.threadId);
    await insertComment(one.threadId);
    // A citation-less comment never counts toward the sourced metric.
    await insertComment(none.threadId, { cited: false });

    const served = await serve('sources');
    expect(served.items.map((i) => i.story_id)).toEqual([three.storyId, one.storyId, none.storyId]);
    // The card signal agrees with the ordering metric by construction.
    expect(served.items[0]?.sources_count).toBe(3);
    const log = await fixture.ranking.decisionLogs.getByRequestId(served.requestId);
    expect(log?.fallback_reason).toBe('user_mode');
    expect(log?.user_ordering).toBe('sources');
  });

  it('`debates` orders by the WS-T corrections tally, newest-first ties', async () => {
    const two = await seedStory(fixture.ingestion, {
      publishedAt: new Date(Date.now() - 3 * HOUR).toISOString(),
    });
    const oneDebate = await seedStory(fixture.ingestion, {
      publishedAt: new Date(Date.now() - 2 * HOUR).toISOString(),
    });
    const none = await seedStory(fixture.ingestion, {
      publishedAt: new Date(Date.now() - 1 * HOUR).toISOString(),
    });
    // Adjudicated comment debates: one UPHELD + one PREVAILED-against on the
    // first story, one UPHELD on the second.
    const upheldA = await insertComment(two.threadId);
    const incorrectA = await insertComment(two.threadId);
    const upheldB = await insertComment(oneDebate.threadId);
    await fixture.forum.contributions.setDisputeStatus(upheldA, 'validated');
    await fixture.forum.contributions.setDisputeStatus(incorrectA, 'incorrect');
    await fixture.forum.contributions.setDisputeStatus(upheldB, 'validated');

    const served = await serve('debates');
    expect(served.items.map((i) => i.story_id)).toEqual([
      two.storyId,
      oneDebate.storyId,
      none.storyId,
    ]);
    expect(served.items[0]?.corrections).toEqual({ active: 0, validated: 1, incorrect: 1 });
    const log = await fixture.ranking.decisionLogs.getByRequestId(served.requestId);
    expect(log?.user_ordering).toBe('debates');
  });

  it('`rising` orders by the PWAtt window-over-window velocity', async () => {
    // The FALLING story is newest and holds the higher CURRENT attention —
    // both chronological order and a plain attention sort would put it first.
    const rising = await seedStory(fixture.ingestion, {
      publishedAt: new Date(Date.now() - 3 * HOUR).toISOString(),
    });
    const falling = await seedStory(fixture.ingestion, {
      publishedAt: new Date(Date.now() - 1 * HOUR).toISOString(),
    });
    const noHistory = await seedStory(fixture.ingestion, {
      publishedAt: new Date(Date.now() - 2 * HOUR).toISOString(),
    });
    await seedAttentionWindows(rising.storyId, 0.1, 0.5); // velocity +0.4
    await seedAttentionWindows(falling.storyId, 0.9, 0.6); // velocity −0.3
    await runFeatureBatch(featureDeps(), 50, 6);

    const served = await serve('rising');
    // Rising first; no-history (velocity 0) beats falling (negative velocity).
    expect(served.items.map((i) => i.story_id)).toEqual([
      rising.storyId,
      noHistory.storyId,
      falling.storyId,
    ]);
    const log = await fixture.ranking.decisionLogs.getByRequestId(served.requestId);
    expect(log?.fallback_reason).toBe('user_mode');
    expect(log?.user_ordering).toBe('rising');
  });

  it('user orderings paginate with the seen-aware cursor chain', async () => {
    const stories = [];
    for (let i = 0; i < 3; i += 1) {
      stories.push(
        await seedStory(fixture.ingestion, {
          publishedAt: new Date(Date.now() - (i + 1) * HOUR).toISOString(),
        }),
      );
    }
    const first = await serve('new');
    expect(first.items.length).toBeGreaterThan(0);
    if (first.nextCursor !== null) {
      const second = await serveFeed(fixture.ranking, {
        userId: null,
        surface: 'front_page',
        surfaceRoomId: null,
        surfaceTopicId: null,
        mode: 'new',
        cursor: first.nextCursor,
      });
      const firstIds = new Set(first.items.map((i) => i.story_id));
      for (const item of second.items) expect(firstIds.has(item.story_id)).toBe(false);
    }
  });

  it('the kill switch outranks an explicit sort request (plain chronological)', async () => {
    const older = await seedStory(fixture.ingestion, {
      publishedAt: new Date(Date.now() - 2 * HOUR).toISOString(),
    });
    const newer = await seedStory(fixture.ingestion, {
      publishedAt: new Date(Date.now() - 1 * HOUR).toISOString(),
    });
    await insertComment(older.threadId); // `sources` would order `older` first
    await engageKillSwitch(
      fixture.events,
      {
        global: true,
        surfaces: [],
        profileIds: [],
        owner: 'oncall',
        triggerCondition: 'incident drill',
        rollbackPath: 'release via admin',
        reviewDate: new Date().toISOString(),
      },
      new Date().toISOString(),
    );
    const served = await serve('sources');
    expect(served.items.map((i) => i.story_id)).toEqual([newer.storyId, older.storyId]);
    const log = await fixture.ranking.decisionLogs.getByRequestId(served.requestId);
    expect(log?.fallback_reason).toBe('kill_switch');
    expect(log?.user_ordering).toBeNull();
  });

  it('user-sorted cards carry the MFCI safety posture (parity with ranked)', async () => {
    // A high-MFCI story that stays distributable must read "under-review" on
    // a user-sorted feed exactly as it does on the ranked feed and the story
    // detail — a user-selected sort changes the ORDER, never the honesty of
    // the card posture.
    const risky = await seedStory(fixture.ingestion, {
      publishedAt: new Date(Date.now() - 2 * HOUR).toISOString(),
    });
    const calm = await seedStory(fixture.ingestion, {
      publishedAt: new Date(Date.now() - 1 * HOUR).toISOString(),
    });
    await fixture.invariants.mfciRiskStates.set({
      targetId: risky.storyId,
      state: 'high',
      score: 6,
      reason: 'score',
      updatedAt: new Date().toISOString(),
    });
    await runFeatureBatch(featureDeps(), 50, 6);

    for (const mode of ['new', 'sources', 'debates', 'rising'] as const) {
      const served = await serve(mode);
      const byId = new Map(served.items.map((i) => [i.story_id, i]));
      expect(byId.get(risky.storyId)?.safety_state).toBe('under-review');
      expect(byId.get(calm.storyId)?.safety_state).toBe('ok');
    }
    // The ranked feed agrees (the parity being asserted).
    const ranked = await serve('best');
    const rankedById = new Map(ranked.items.map((i) => [i.story_id, i]));
    expect(rankedById.get(risky.storyId)?.safety_state).toBe('under-review');
  });

  it('degradation fallbacks still carry the MFCI safety posture (kill-switch parity)', async () => {
    // The WS-I.4.1b degradation fallbacks (kill switch / GWEI gate / empty pool)
    // serve FEATURE-BLIND so no PWAtt value leaks under §30.5 — but the MFCI
    // safety posture is a WS-H integrity signal read from the DURABLE store, so
    // a high/severe-MFCI story must STILL read "under-review" on a killed feed,
    // exactly as the un-gated story-detail read does (before the parity fix a
    // degraded card read "ok" while story-detail read "under review"). NO
    // feature batch runs here — the durable posture is the whole point.
    const risky = await seedStory(fixture.ingestion, {
      publishedAt: new Date(Date.now() - 2 * HOUR).toISOString(),
    });
    const calm = await seedStory(fixture.ingestion, {
      publishedAt: new Date(Date.now() - 1 * HOUR).toISOString(),
    });
    await fixture.invariants.mfciRiskStates.set({
      targetId: risky.storyId,
      state: 'severe',
      score: 9,
      reason: 'score',
      updatedAt: new Date().toISOString(),
    });
    await engageKillSwitch(
      fixture.events,
      {
        global: true,
        surfaces: [],
        profileIds: [],
        owner: 'oncall',
        triggerCondition: 'incident drill',
        rollbackPath: 'release via admin',
        reviewDate: new Date().toISOString(),
      },
      new Date().toISOString(),
    );
    const served = await serve('best');
    const log = await fixture.ranking.decisionLogs.getByRequestId(served.requestId);
    expect(log?.fallback_reason).toBe('kill_switch');
    const byId = new Map(served.items.map((i) => [i.story_id, i]));
    expect(byId.get(risky.storyId)?.safety_state).toBe('under-review');
    expect(byId.get(calm.storyId)?.safety_state).toBe('ok');
    // §30.5 preserved: the degraded serve carries NO PWAtt-derived value, so
    // the legacy rating_label rides only the (integrity) safety posture.
    expect(byId.get(risky.storyId)?.rating_label).toBe('under-review');
  });

  it('a user sort never logs a GWEI gate application it did not serve under', async () => {
    // A promoted, over-threshold GWEI gate blocks RANKED deployment — but a
    // user-selected ordering is not a deployment of the ranked objective, so
    // its decision log must not claim a gate exclusion was applied.
    await seedStory(fixture.ingestion);
    await promoteInvariant(fixture.invariants, 'GWEI');
    await seedInvariantOutput(fixture.events, {
      invariantType: 'GWEI',
      targetId: randomUUID(),
      targetType: 'cohort',
      scoreVector: { gw2: 0.9 },
    });
    const userSorted = await serve('sources');
    const userLog = await fixture.ranking.decisionLogs.getByRequestId(userSorted.requestId);
    expect(userLog?.fallback_reason).toBe('user_mode');
    expect(userLog?.constraints_applied.some((c) => c.constraint === 'gwei_deployment_gate')).toBe(
      false,
    );
    // The gate still bites the ranked objective — and THAT log records it.
    const gated = await serve('best');
    const gatedLog = await fixture.ranking.decisionLogs.getByRequestId(gated.requestId);
    expect(gatedLog?.fallback_reason).toBe('gwei_gate');
    expect(gatedLog?.constraints_applied.some((c) => c.constraint === 'gwei_deployment_gate')).toBe(
      true,
    );
  });
});

describe('legacy feed modes (pre-redesign wire/storage compat)', () => {
  it('`balanced` normalizes to the ranked pipeline', async () => {
    await seedStory(fixture.ingestion);
    const served = await serve('balanced');
    expect(served.fallback).toBe(false);
  });

  it('`chronological` normalizes to `new`', async () => {
    await seedStory(fixture.ingestion);
    const served = await serve('chronological');
    const log = await fixture.ranking.decisionLogs.getByRequestId(served.requestId);
    expect(log?.fallback_reason).toBe('user_mode');
    expect(log?.user_ordering).toBe('new');
  });

  it('`source-diverse` serves ranked with NO balancing override', async () => {
    await seedStory(fixture.ingestion);
    const served = await serve('source-diverse');
    expect(served.fallback).toBe(false);
    const log = await fixture.ranking.decisionLogs.getByRequestId(served.requestId);
    expect(log?.replay_inputs?.max_source_share_pct_override).toBeNull();
  });

  it('`local` serves ranked with NO local-quota boost', async () => {
    const { userId } = await seedUserWithSession(fixture.identity);
    await fixture.identity.store.updateUser(userId, { locale: 'en-GB' });
    await seedStory(fixture.ingestion, { locationScope: { type: 'country', value: 'GB' } });
    await seedStory(fixture.ingestion);
    const served = await serve('local', userId);
    expect(served.fallback).toBe(false);
    const log = await fixture.ranking.decisionLogs.getByRequestId(served.requestId);
    const local = log?.quota_outcomes.find((q) => q.quota_type === 'local');
    // The §13.2 diversity quota keeps its PROFILE target — the removed mode
    // no longer triples it.
    expect(local?.target_pct).toBe(10);
  });

  it('`low-personalization` normalizes to the fully non-personalized `new` sort', async () => {
    // The legacy mode meant "less personalization" — mapping it to `best`
    // would silently re-enable personalized ranking once an updated client
    // normalizes and re-sends the canonical mode. `new` preserves the intent
    // on EVERY path (live request, stored default, persisted slice): the
    // chronological user ordering has no personalization term at all.
    const { userId } = await seedUserWithSession(fixture.identity);
    await seedStory(fixture.ingestion);
    const served = await serve('low-personalization', userId);
    expect(served.fallback).toBe(true);
    const log = await fixture.ranking.decisionLogs.getByRequestId(served.requestId);
    expect(log?.fallback_reason).toBe('user_mode');
    expect(log?.user_ordering).toBe('new');
    expect(log?.replay_inputs).toBeNull(); // no personalization inputs exist
    // The same user on `best` gets personalization (enabled by default) —
    // the legacy value alone kept it out of the ranked path.
    const ranked = await serve('best', userId);
    const rankedLog = await fixture.ranking.decisionLogs.getByRequestId(ranked.requestId);
    expect(rankedLog?.replay_inputs?.topic_relevance).not.toBeNull();
  });
  it('a legacy STORED default normalizes too', async () => {
    const { userId } = await seedUserWithSession(fixture.identity);
    const user = await fixture.identity.store.getUser(userId);
    if (user === null) throw new Error('seed failed');
    await fixture.identity.store.updateUser(userId, {
      personalizationSettings: {
        ...user.personalizationSettings,
        feed_mode: 'chronological',
      },
    });
    await seedStory(fixture.ingestion);
    const served = await serve(undefined, userId);
    const log = await fixture.ranking.decisionLogs.getByRequestId(served.requestId);
    expect(log?.fallback_reason).toBe('user_mode');
    expect(log?.user_ordering).toBe('new');
  });
});

describe('attention_velocity feature assembly', () => {
  it('computes the signed delta of the two most recent serving windows', async () => {
    const { storyId } = await seedStory(fixture.ingestion);
    await seedAttentionWindows(storyId, 0.2, 0.7);
    const vector = await assembleFeatureVector(featureDeps(), storyId);
    expect(vector?.attention_velocity).toBeCloseTo(0.5, 10);
  });

  it('is ABSENT with a single window (honest absence, never zero)', async () => {
    const { storyId } = await seedStory(fixture.ingestion);
    await seedInvariantOutput(fixture.events, {
      invariantType: 'PWAtt_v1',
      targetId: storyId,
      scoreVector: { active_attention: 0.7, participation: 0.5 },
      shadowMode: false,
    });
    const vector = await assembleFeatureVector(featureDeps(), storyId);
    expect(vector?.active_attention).toBeCloseTo(0.7, 10);
    expect(vector?.attention_velocity).toBeUndefined();
  });

  it('a SHADOW previous window cannot feed a velocity (§30.5 gate)', async () => {
    const { storyId } = await seedStory(fixture.ingestion);
    await seedInvariantOutput(fixture.events, {
      invariantType: 'PWAtt_v1',
      targetId: storyId,
      scoreVector: { active_attention: 0.1, participation: 0.5 },
      shadowMode: true, // pre-lift row: powerless
      timeWindow: { start: '2026-06-10T00:00:00.000Z', end: '2026-06-10T01:00:00.000Z' },
      createdAt: '2026-06-10T01:00:05.000Z',
    });
    await seedInvariantOutput(fixture.events, {
      invariantType: 'PWAtt_v1',
      targetId: storyId,
      scoreVector: { active_attention: 0.9, participation: 0.5 },
      shadowMode: false,
      timeWindow: { start: '2026-06-10T01:00:00.000Z', end: '2026-06-10T02:00:00.000Z' },
      createdAt: '2026-06-10T02:00:05.000Z',
    });
    const vector = await assembleFeatureVector(featureDeps(), storyId);
    expect(vector?.attention_velocity).toBeUndefined();
  });

  it('a DIFFERENT-size earlier window cannot feed a velocity', async () => {
    const { storyId } = await seedStory(fixture.ingestion);
    await seedInvariantOutput(fixture.events, {
      invariantType: 'PWAtt_v1',
      targetId: storyId,
      scoreVector: { active_attention: 0.1, participation: 0.5 },
      shadowMode: false,
      // A 24h window — not comparable to the 1h current window.
      timeWindow: { start: '2026-06-09T01:00:00.000Z', end: '2026-06-10T01:00:00.000Z' },
      createdAt: '2026-06-10T01:00:05.000Z',
    });
    await seedInvariantOutput(fixture.events, {
      invariantType: 'PWAtt_v1',
      targetId: storyId,
      scoreVector: { active_attention: 0.9, participation: 0.5 },
      shadowMode: false,
      timeWindow: { start: '2026-06-10T01:00:00.000Z', end: '2026-06-10T02:00:00.000Z' },
      createdAt: '2026-06-10T02:00:05.000Z',
    });
    const vector = await assembleFeatureVector(featureDeps(), storyId);
    expect(vector?.attention_velocity).toBeUndefined();
  });
});
