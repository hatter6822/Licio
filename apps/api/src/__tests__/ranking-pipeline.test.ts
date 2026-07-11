// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-I.2/4 pipeline acceptance: the feature store (revisions, validation,
// denylist, real-time consumer, batch), the safety filter (non-overridable),
// end-to-end feed serving (ranked + every fallback path), the 1:1 decision
// log with replay (WS-I.2.5b), the kill switch (WS-I.4.1a), the runtime
// config (fail-closed + 422 writes), the admin surface (steward + MFA,
// meta-audited), and the maintenance scheduler.

import { randomUUID } from 'node:crypto';
import { DeniedFinancialFieldError, EVERGREEN_PROFILE } from '@licio/ranking';
import { UNCLASSIFIED_TOPIC_ID } from '@licio/shared';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_RANKING_CONFIG,
  loadRankingRuntimeConfig,
  validateRankingConfigValue,
} from '../ranking/config.js';
import { assembleFeatureVector, refreshFeatures, runFeatureBatch } from '../ranking/features.js';
import {
  engageKillSwitch,
  KILLSWITCH_CONFIG_KEY,
  killSwitchDecision,
  releaseKillSwitch,
} from '../ranking/killswitch.js';
import {
  applySafetyFilter,
  createDefaultModerationStateProvider,
} from '../ranking/safety-filter.js';
import { runRankingTick } from '../ranking/scheduler.js';
import { replayDecision, serveFeed } from '../ranking/service.js';
import { registerRankingConsumers } from '../ranking/services.js';
import { InMemoryFeatureStore } from '../ranking/stores.js';
import { createV1Routes } from '../routes/v1.js';
import { seedUserWithSession } from './event-test-helpers.js';
import {
  freshRankingServices,
  promoteInvariant,
  type RankingFixture,
  seedInvariantOutput,
  seedStory,
} from './ranking-helpers.js';

let fixture: RankingFixture;

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

beforeEach(() => {
  fixture = freshRankingServices();
});

describe('feature store (WS-I.2.1d storage semantics)', () => {
  it('appends monotonic revisions; stale writers lose', async () => {
    const store = new InMemoryFeatureStore();
    const base = await assembleVector();
    expect((await store.upsert(base))?.revision).toBe(0);
    // A writer that built from revision 0 writes revision 1.
    expect((await store.upsert({ ...base, revision: 1 }))?.revision).toBe(1);
    // A STALE writer re-submitting revision 1 is rejected.
    expect(await store.upsert({ ...base, revision: 1 })).toBeNull();
    // History is immutable: both revisions stay readable (replay).
    expect((await store.getRevision(base.item_id, 0))?.revision).toBe(0);
    expect((await store.getRevision(base.item_id, 1))?.revision).toBe(1);
    expect((await store.getLatest(base.item_id))?.revision).toBe(1);
  });

  it('rejects denied financial fields with the typed error (WS-I.2.1b)', async () => {
    const store = new InMemoryFeatureStore();
    const vector = await assembleVector();
    await expect(
      store.upsert({ ...vector, wallet_balance: 100 } as unknown as typeof vector),
    ).rejects.toThrow(DeniedFinancialFieldError);
    // Nothing was written (no privileged path).
    expect(await store.getLatest(vector.item_id)).toBeNull();
  });

  async function assembleVector() {
    const { storyId } = await seedStory(fixture.ingestion);
    const vector = await assembleFeatureVector(featureDeps(), storyId);
    if (vector === null) throw new Error('assembly failed');
    return vector;
  }
});

describe('feature assembly (WS-I.2.1a/c provenance)', () => {
  it('joins PWAtt components from POST-LIFT rows only (shadow rows stay powerless)', async () => {
    const lifted = await seedStory(fixture.ingestion);
    const preLift = await seedStory(fixture.ingestion);
    await seedInvariantOutput(fixture.events, {
      invariantType: 'PWAtt_v1',
      targetId: lifted.storyId,
      scoreVector: { active_attention: 0.7, participation: 0.6 },
      shadowMode: false,
    });
    await seedInvariantOutput(fixture.events, {
      invariantType: 'PWAtt_v1',
      targetId: preLift.storyId,
      scoreVector: { active_attention: 0.7, participation: 0.6 },
      shadowMode: true, // a row stored BEFORE the §30.5 lift
    });
    const liftedVector = await assembleFeatureVector(featureDeps(), lifted.storyId);
    const preLiftVector = await assembleFeatureVector(featureDeps(), preLift.storyId);
    expect(liftedVector?.active_attention).toBe(0.7);
    expect(liftedVector?.constructive_participation).toBe(0.6);
    expect(liftedVector?.invariant_versions['PWAtt_v1']).toBeDefined();
    expect(preLiftVector?.active_attention).toBeUndefined();
    expect(preLiftVector?.invariant_versions['PWAtt_v1']).toBeUndefined();
  });

  it('joins MFCI (risk-state store canonical), SCOI, Hodge — with version entries', async () => {
    const { storyId, threadId } = await seedStory(fixture.ingestion);
    await fixture.invariants.mfciRiskStates.set({
      targetId: storyId,
      state: 'high',
      score: 3.2,
      reason: 'score',
      updatedAt: new Date().toISOString(),
    });
    await seedInvariantOutput(fixture.events, {
      invariantType: 'MFCI',
      targetId: storyId,
      scoreVector: { mfci: 3.2, risk_state: 'high' },
    });
    await seedInvariantOutput(fixture.events, {
      invariantType: 'SCOI',
      targetId: storyId,
      scoreVector: { scoi: 0.3, context_state: 'obstructed' },
    });
    await seedInvariantOutput(fixture.events, {
      invariantType: 'hodge_tension',
      targetId: threadId,
      targetType: 'thread',
      scoreVector: { harmonic_fraction: 0.4, harmful_tension_risk: 0 },
    });
    const vector = await assembleFeatureVector(featureDeps(), storyId);
    expect(vector?.mfci_risk_state).toBe('high');
    expect(vector?.mfci_score).toBe(3.2);
    expect(vector?.coordination_penalty).toBe(0.5);
    expect(vector?.scoi_level).toBe('high'); // obstructed → high
    expect(vector?.context_coherence_gain).toBeCloseTo(0.7, 12);
    expect(vector?.hodge_harmonic_tension).toBe(0.4);
    expect(vector?.harmful_tension_risk).toBe(0);
    for (const name of ['MFCI', 'SCOI', 'hodge_tension']) {
      const entry = vector?.invariant_versions[name];
      expect(entry?.version_string).toBe('1.0.0');
      expect(entry?.config_hash.length).toBe(16);
    }
  });

  it('treats degraded outputs as ABSENT features (WS-H.1.2c)', async () => {
    const { storyId } = await seedStory(fixture.ingestion);
    await seedInvariantOutput(fixture.events, {
      invariantType: 'SCOI',
      targetId: storyId,
      scoreVector: { scoi: 0.9, context_state: 'weaponized' },
      reasonCodes: ['COMPUTE_ERROR'],
      fallbackUsed: true,
    });
    const vector = await assembleFeatureVector(featureDeps(), storyId);
    expect(vector?.scoi_level).toBeUndefined();
    expect(vector?.context_coherence_gain).toBeUndefined();
  });

  it('excludes the UNCLASSIFIED sentinel from feature topic_ids (WS-I topic logic)', async () => {
    const { storyId } = await seedStory(fixture.ingestion, { topicIds: [UNCLASSIFIED_TOPIC_ID] });
    const vector = await assembleFeatureVector(featureDeps(), storyId);
    // An unclassified story carries NO real topic into ranking — no `?topic=`
    // surface match, no per-topic balancing collision with other unclassified
    // items masquerading as one shared subject.
    expect(vector?.topic_ids).toEqual([]);
  });

  it('carries non-none sensitivity labels into the feature vector (WS-I §11.5)', async () => {
    const { storyId } = await seedStory(fixture.ingestion, {
      sensitivityLabels: ['crisis', 'none'],
    });
    const vector = await assembleFeatureVector(featureDeps(), storyId);
    expect(vector?.sensitivity_labels).toEqual(['crisis']);
  });

  it('the real-time consumer refreshes features on invariant.run.completed', async () => {
    registerRankingConsumers(fixture.ranking);
    const { storyId } = await seedStory(fixture.ingestion);
    await seedInvariantOutput(fixture.events, {
      invariantType: 'SCOI',
      targetId: storyId,
      scoreVector: { scoi: 0.2, context_state: 'ambiguous' },
    });
    await fixture.events.router.publish({
      event_id: randomUUID(),
      event_type: 'invariant.run.completed',
      timestamp: new Date().toISOString(),
      schema_version: '1',
      invariant_type: 'SCOI',
      target_type: 'story',
      target_id: storyId,
      time_window: '2026-06-10T00:00:00.000Z/1h',
      version: '1.0.0',
      score_vector: { scoi: 0.2 },
      confidence: 1,
      computation_time_ms: 5,
      privacy_classification: 'sensitive',
      retention_tier: 'ranking_log',
    } as never);
    const stored = await fixture.ranking.featureStore.getLatest(storyId);
    expect(stored?.scoi_level).toBe('medium');
  });

  it('the batch path covers recent stories (WS-I.2.1d)', async () => {
    const a = await seedStory(fixture.ingestion);
    const b = await seedStory(fixture.ingestion);
    const result = await runFeatureBatch(featureDeps(), 50, 6);
    expect(result.refreshed).toBe(2);
    expect(await fixture.ranking.featureStore.getLatest(a.storyId)).not.toBeNull();
    expect(await fixture.ranking.featureStore.getLatest(b.storyId)).not.toBeNull();
  });
});

describe('safety filter (WS-I.2.2a, non-overridable)', () => {
  it('excludes removed/hidden/restricted/unknown items with policy reasons', async () => {
    const visible = await seedStory(fixture.ingestion);
    const takedown = await seedStory(fixture.ingestion, { hiddenState: 'takedown' });
    const integrityRemoved = await seedStory(fixture.ingestion);
    await fixture.events.safetyStore.set({
      itemId: integrityRemoved.storyId,
      safetyState: 'removed',
      frozenScore: null,
      caseId: 'case-1',
      updatedBy: 'system',
      updatedAt: new Date().toISOString(),
    });
    const restricted = await seedStory(fixture.ingestion);
    await fixture.ingestion.stories.updateThread(restricted.threadId, {
      safetyState: 'restricted',
    });
    const provider = createDefaultModerationStateProvider({
      events: fixture.events,
      stories: fixture.ingestion.stories,
      shadowedSubjects: async () => new Set(),
    });
    const candidates = [
      visible.storyId,
      takedown.storyId,
      integrityRemoved.storyId,
      restricted.storyId,
      randomUUID(), // unknown item: fail closed
    ].map((id) => ({
      item_id: id,
      item_type: 'story' as const,
      source_type: 'global' as const,
      room_id: null,
      visibility: 'public' as const,
      topic_ids: [],
      source_id: null,
      freshness_timestamp: new Date().toISOString(),
      retrieval_score: 0.5,
      retrieval_origins: ['global_pwatt_v1'],
      bridge_context: null,
    }));
    const result = await applySafetyFilter(candidates, provider, {
      ageBand: 'adult',
      jurisdiction: null,
    });
    expect(result.feasible.map((c) => c.item_id)).toEqual([visible.storyId]);
    const reasons = new Map(result.exclusions.map((e) => [e.item_id, e.policy_reason]));
    expect(reasons.get(takedown.storyId)).toBe('takedown_removal');
    expect(reasons.get(integrityRemoved.storyId)).toBe('integrity_removal');
    expect(reasons.get(restricted.storyId)).toBe('thread_restricted');
    expect(
      result.exclusions.find((e) => e.item_id === integrityRemoved.storyId)?.moderation_case_ref,
    ).toBe('case-1');
  });

  it('excludes a shadowed author from organic feeds (author_shadow); a takedown still wins', async () => {
    const shadowedAuthor = '00000000-0000-4000-8000-00000000a5ad';
    const plain = await seedStory(fixture.ingestion, { submittedBy: shadowedAuthor });
    const takenDown = await seedStory(fixture.ingestion, {
      submittedBy: shadowedAuthor,
      hiddenState: 'takedown',
    });
    const other = await seedStory(fixture.ingestion); // a different (non-shadowed) author
    const provider = createDefaultModerationStateProvider({
      events: fixture.events,
      stories: fixture.ingestion.stories,
      // Only `shadowedAuthor` is under a standing shadow.
      shadowedSubjects: async (ids) => new Set(ids.filter((id) => id === shadowedAuthor)),
    });
    const candidates = [plain.storyId, takenDown.storyId, other.storyId].map((id) => ({
      item_id: id,
      item_type: 'story' as const,
      source_type: 'global' as const,
      room_id: null,
      visibility: 'public' as const,
      topic_ids: [],
      source_id: null,
      freshness_timestamp: new Date().toISOString(),
      retrieval_score: 0.5,
      retrieval_origins: ['global_pwatt_v1'],
      bridge_context: null,
    }));
    const result = await applySafetyFilter(candidates, provider, {
      ageBand: 'adult',
      jurisdiction: null,
    });
    const reasons = new Map(result.exclusions.map((e) => [e.item_id, e.policy_reason]));
    // The shadowed author's plain story → excluded as author_shadow.
    expect(reasons.get(plain.storyId)).toBe('author_shadow');
    // Their taken-down story → the more-specific takedown reason wins.
    expect(reasons.get(takenDown.storyId)).toBe('takedown_removal');
    // A non-shadowed author's story keeps its organic reach.
    expect(result.feasible.map((c) => c.item_id)).toEqual([other.storyId]);
  });

  it('age-gates graphic/crisis content for teens AND unknown-age requests', async () => {
    const graphic = await seedStory(fixture.ingestion, { sensitivityLabels: ['graphic'] });
    const provider = createDefaultModerationStateProvider({
      events: fixture.events,
      stories: fixture.ingestion.stories,
      shadowedSubjects: async () => new Set(),
    });
    const candidate = {
      item_id: graphic.storyId,
      item_type: 'story' as const,
      source_type: 'global' as const,
      room_id: null,
      visibility: 'public' as const,
      topic_ids: [],
      source_id: null,
      freshness_timestamp: new Date().toISOString(),
      retrieval_score: 0.5,
      retrieval_origins: ['global_pwatt_v1'],
      bridge_context: null,
    };
    for (const ageBand of ['teen_13_15', 'teen_16_17', null] as const) {
      const filtered = await applySafetyFilter([candidate], provider, {
        ageBand,
        jurisdiction: null,
      });
      expect(filtered.feasible).toHaveLength(0);
      expect(filtered.exclusions[0]?.policy_reason).toBe('age_inappropriate');
    }
    const adult = await applySafetyFilter([candidate], provider, {
      ageBand: 'adult',
      jurisdiction: null,
    });
    expect(adult.feasible).toHaveLength(1);
  });
});

describe('feed serving end to end (SPEC §13.3 stages)', () => {
  it('serves a ranked feed with explanations, ONE decision log, and request id', async () => {
    const strong = await seedStory(fixture.ingestion, {
      publishedAt: new Date(Date.now() - 3_600_000).toISOString(),
    });
    const weak = await seedStory(fixture.ingestion, {
      publishedAt: new Date(Date.now() - 3_600_000).toISOString(),
    });
    await seedInvariantOutput(fixture.events, {
      invariantType: 'PWAtt_v1',
      targetId: strong.storyId,
      scoreVector: { active_attention: 0.9, participation: 0.9 },
      shadowMode: false,
    });
    await runFeatureBatch(featureDeps(), 50, 6);
    const served = await serveFeed(fixture.ranking, {
      userId: null,
      surface: 'front_page',
      surfaceRoomId: null,
      surfaceTopicId: null,
      mode: undefined,
    });
    expect(served.fallback).toBe(false);
    expect(served.items.map((i) => i.story_id)).toEqual([strong.storyId, weak.storyId]);
    for (const item of served.items) {
      expect(item.distribution_reason.length).toBeGreaterThan(0);
    }
    const log = await fixture.ranking.decisionLogs.getByRequestId(served.requestId);
    expect(log).not.toBeNull();
    expect(log?.fallback).toBe(false);
    expect(log?.user_privacy_bucket).toBe('anonymous');
    expect(log?.selected_ids).toEqual([strong.storyId, weak.storyId]);
    expect(log?.candidate_ids).toContain(strong.storyId);
    expect(Object.keys(log?.score_components ?? {})).toHaveLength(2);
    expect(log?.explanation_ids[strong.storyId]).toBeDefined();
    expect(log?.replay_inputs?.profile_snapshot.profile_id).toBe(log?.profile_id);
    expect(await fixture.ranking.decisionLogs.count()).toBe(1);
    // §21.3: one ranking.decision.logged event per selected item.
    const eventRows = await fixture.events.eventStore.listByTopicsBetween(
      ['ranking.decision.logged'],
      new Date(0).toISOString(),
      new Date(Date.now() + 86_400_000).toISOString(),
    );
    expect(eventRows).toHaveLength(2);
  });

  it('safety-filtered items NEVER appear, regardless of score (WS-I.2.2a)', async () => {
    // Takedown/safety-hidden stories never even RETRIEVE (defense in depth
    // at the retrievers); the authoritative filter is proven through the
    // WS-E integrity-removal state, which retrieval does not pre-check.
    const hidden = await seedStory(fixture.ingestion, { hiddenState: 'safety' });
    const removed = await seedStory(fixture.ingestion);
    const visible = await seedStory(fixture.ingestion);
    await fixture.events.safetyStore.set({
      itemId: removed.storyId,
      safetyState: 'removed',
      frozenScore: null,
      caseId: 'case-removed',
      updatedBy: 'system',
      updatedAt: new Date().toISOString(),
    });
    await seedInvariantOutput(fixture.events, {
      invariantType: 'PWAtt_v1',
      targetId: removed.storyId,
      scoreVector: { active_attention: 1, participation: 1 },
      shadowMode: false,
    });
    await runFeatureBatch(featureDeps(), 50, 6);
    const served = await serveFeed(fixture.ranking, {
      userId: null,
      surface: 'front_page',
      surfaceRoomId: null,
      surfaceTopicId: null,
      mode: undefined,
    });
    // Neither the hidden story (never retrieved) nor the integrity-removed
    // story (retrieved, then excluded by the AUTHORITATIVE filter) serves —
    // a perfect PWAtt score cannot override the removal (§24.4).
    expect(served.items.map((i) => i.story_id)).toEqual([visible.storyId]);
    const log = await fixture.ranking.decisionLogs.getByRequestId(served.requestId);
    expect(log?.candidate_ids).not.toContain(hidden.storyId);
    const exclusion = log?.safety_exclusions.find((e) => e.item_id === removed.storyId);
    expect(exclusion?.policy_reason).toBe('integrity_removal');
    expect(exclusion?.moderation_case_ref).toBe('case-removed');
  });

  it('personalization-off users get NO topic relevance (and the log shows it)', async () => {
    const { userId } = await seedUserWithSession(fixture.identity);
    const user = await fixture.identity.store.getUser(userId);
    if (user === null) throw new Error('seed failed');
    await fixture.identity.store.updateUser(userId, {
      privacySettings: { ...user.privacySettings, personalization_enabled: false },
    });
    await seedStory(fixture.ingestion);
    const served = await serveFeed(fixture.ranking, {
      userId,
      surface: 'front_page',
      surfaceRoomId: null,
      surfaceTopicId: null,
      mode: undefined,
    });
    const log = await fixture.ranking.decisionLogs.getByRequestId(served.requestId);
    expect(log?.replay_inputs?.topic_relevance).toBeNull();
    for (const scored of Object.values(log?.score_components ?? {})) {
      expect(scored.baseline.topic_relevance).toBeNull();
    }
  });

  it('the kill switch serves the chronological fallback with the honest reason', async () => {
    const older = await seedStory(fixture.ingestion, {
      publishedAt: new Date(Date.now() - 7_200_000).toISOString(),
    });
    const newer = await seedStory(fixture.ingestion, {
      publishedAt: new Date(Date.now() - 3_600_000).toISOString(),
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
    const served = await serveFeed(fixture.ranking, {
      userId: null,
      surface: 'front_page',
      surfaceRoomId: null,
      surfaceTopicId: null,
      mode: undefined,
    });
    expect(served.fallback).toBe(true);
    expect(served.items.map((i) => i.story_id)).toEqual([newer.storyId, older.storyId]);
    expect(served.items[0]?.distribution_reason).toBe(
      'Shown in time order while ranking is paused.',
    );
    const log = await fixture.ranking.decisionLogs.getByRequestId(served.requestId);
    expect(log?.fallback).toBe(true);
    expect(log?.fallback_reason).toBe('kill_switch');
    // Release restores ranked serving without a deployment.
    await releaseKillSwitch(fixture.events, 'oncall');
    const restored = await serveFeed(fixture.ranking, {
      userId: null,
      surface: 'front_page',
      surfaceRoomId: null,
      surfaceTopicId: null,
      mode: undefined,
    });
    expect(restored.fallback).toBe(false);
  });

  it('an UNREADABLE kill-switch state fails closed to the fallback', async () => {
    await seedStory(fixture.ingestion);
    await fixture.events.configStore.set(KILLSWITCH_CONFIG_KEY, { garbage: true });
    const decision = await killSwitchDecision(fixture.events, 'front_page', 'evergreen');
    expect(decision).toEqual({ engaged: true, scope: 'unreadable_state' });
    const served = await serveFeed(fixture.ranking, {
      userId: null,
      surface: 'front_page',
      surfaceRoomId: null,
      surfaceTopicId: null,
      mode: undefined,
    });
    expect(served.fallback).toBe(true);
  });

  it('per-surface and per-profile scopes engage selectively (WS-I.4.1a)', async () => {
    await engageKillSwitch(
      fixture.events,
      {
        global: false,
        surfaces: ['room'],
        profileIds: ['breaking_news'],
        owner: 'oncall',
        triggerCondition: 'scoped drill',
        rollbackPath: 'release',
        reviewDate: new Date().toISOString(),
      },
      new Date().toISOString(),
    );
    expect((await killSwitchDecision(fixture.events, 'room', 'evergreen')).engaged).toBe(true);
    expect((await killSwitchDecision(fixture.events, 'front_page', 'breaking_news')).engaged).toBe(
      true,
    );
    expect((await killSwitchDecision(fixture.events, 'front_page', 'evergreen')).engaged).toBe(
      false,
    );
  });

  it('the user-chosen chronological mode serves time order with its own reason', async () => {
    await seedStory(fixture.ingestion);
    const served = await serveFeed(fixture.ranking, {
      userId: null,
      surface: 'front_page',
      surfaceRoomId: null,
      surfaceTopicId: null,
      mode: 'chronological',
    });
    expect(served.fallback).toBe(true);
    expect(served.items[0]?.distribution_reason).toBe(
      'Shown in time order, as your feed mode requests.',
    );
    const log = await fixture.ranking.decisionLogs.getByRequestId(served.requestId);
    expect(log?.fallback_reason).toBe('user_mode');
  });

  it('a PROMOTED GWEI gate above threshold blocks ranked serving', async () => {
    await seedStory(fixture.ingestion);
    await promoteInvariant(fixture.invariants, 'GWEI');
    await seedInvariantOutput(fixture.events, {
      invariantType: 'GWEI',
      targetId: randomUUID(),
      targetType: 'cohort',
      scoreVector: { gw2: 0.9 },
    });
    const served = await serveFeed(fixture.ranking, {
      userId: null,
      surface: 'front_page',
      surfaceRoomId: null,
      surfaceTopicId: null,
      mode: undefined,
    });
    expect(served.fallback).toBe(true);
    const log = await fixture.ranking.decisionLogs.getByRequestId(served.requestId);
    expect(log?.fallback_reason).toBe('gwei_gate');
    expect(log?.constraints_applied.some((c) => c.constraint === 'gwei_deployment_gate')).toBe(
      true,
    );
  });

  it('UNPROMOTED penalties are logged but never applied end to end (WS-H.1.2e)', async () => {
    const flagged = await seedStory(fixture.ingestion);
    await fixture.invariants.mfciRiskStates.set({
      targetId: flagged.storyId,
      state: 'severe',
      score: 9,
      reason: 'score',
      updatedAt: new Date().toISOString(),
    });
    await runFeatureBatch(featureDeps(), 50, 6);
    const served = await serveFeed(fixture.ranking, {
      userId: null,
      surface: 'front_page',
      surfaceRoomId: null,
      surfaceTopicId: null,
      mode: undefined,
    });
    // MFCI is shadow: the severe item still serves; its penalty shows
    // value > 0, applied = 0, enforced = false; the exclusion is logged
    // un-enforced.
    expect(served.items.map((i) => i.story_id)).toContain(flagged.storyId);
    const log = await fixture.ranking.decisionLogs.getByRequestId(served.requestId);
    const scored = log?.score_components[flagged.storyId];
    expect(scored?.penalty_components.coordination.value).toBe(1);
    expect(scored?.penalty_components.coordination.applied).toBe(0);
    expect(scored?.penalty_components.coordination.enforced).toBe(false);
    expect(
      log?.constraints_applied.find((c) => c.constraint === 'mfci_severe_cross_community')
        ?.enforced,
    ).toBe(false);
  });

  it('a PROMOTED MFCI severe item leaves cross-community distribution', async () => {
    const flagged = await seedStory(fixture.ingestion);
    const clean = await seedStory(fixture.ingestion);
    await promoteInvariant(fixture.invariants, 'MFCI');
    await fixture.invariants.mfciRiskStates.set({
      targetId: flagged.storyId,
      state: 'severe',
      score: 9,
      reason: 'score',
      updatedAt: new Date().toISOString(),
    });
    await runFeatureBatch(featureDeps(), 50, 6);
    const served = await serveFeed(fixture.ranking, {
      userId: null,
      surface: 'front_page',
      surfaceRoomId: null,
      surfaceTopicId: null,
      mode: undefined,
    });
    expect(served.items.map((i) => i.story_id)).toEqual([clean.storyId]);
  });

  it('the /v1/feed route serves the pipeline with request_id (real stories)', async () => {
    await seedStory(fixture.ingestion);
    const app = new Hono().route('/v1', createV1Routes());
    const response = await app.request('/v1/feed');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: unknown[]; request_id?: string };
    expect(body.items).toHaveLength(1);
    expect(body.request_id).toBeDefined();
    expect(await fixture.ranking.decisionLogs.count()).toBe(1);
  });

  it('the demo contract serves with NO stories (and no decision log)', async () => {
    const app = new Hono().route('/v1', createV1Routes());
    const response = await app.request('/v1/feed');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: unknown[]; request_id?: string };
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.request_id).toBeUndefined();
    expect(await fixture.ranking.decisionLogs.count()).toBe(0);
  });
});

describe('replay (WS-I.2.5b)', () => {
  async function serveRanked() {
    const a = await seedStory(fixture.ingestion, {
      publishedAt: new Date(Date.now() - 3_600_000).toISOString(),
    });
    const _b = await seedStory(fixture.ingestion, {
      publishedAt: new Date(Date.now() - 7_200_000).toISOString(),
    });
    await seedInvariantOutput(fixture.events, {
      invariantType: 'PWAtt_v1',
      targetId: a.storyId,
      scoreVector: { active_attention: 0.8, participation: 0.7 },
      shadowMode: false,
    });
    await runFeatureBatch(featureDeps(), 50, 6);
    return serveFeed(fixture.ranking, {
      userId: null,
      surface: 'front_page',
      surfaceRoomId: null,
      surfaceTopicId: null,
      mode: undefined,
    });
  }

  it('replays a ranked decision to an EXACT match at the recorded versions', async () => {
    const served = await serveRanked();
    expect(served.fallback).toBe(false);
    const result = await replayDecision(fixture.ranking, served.requestId);
    expect(result.problems).toEqual([]);
    expect(result.match).toBe(true);
    expect(result.diff).toEqual([]);
  });

  it('replay still matches after NEWER feature revisions land (pinned snapshot)', async () => {
    const served = await serveRanked();
    // New invariant data arrives; features advance to new revisions.
    const log = await fixture.ranking.decisionLogs.getByRequestId(served.requestId);
    const someId = log?.selected_ids[0] as string;
    await seedInvariantOutput(fixture.events, {
      invariantType: 'PWAtt_v1',
      targetId: someId,
      scoreVector: { active_attention: 0.01, participation: 0.01 },
      shadowMode: false,
      createdAt: new Date(Date.now() + 1000).toISOString(),
    });
    await refreshFeatures(featureDeps(), someId);
    const result = await replayDecision(fixture.ranking, served.requestId);
    expect(result.match).toBe(true);
  });

  it('a modified profile produces a structured diff', async () => {
    const served = await serveRanked();
    const log = await fixture.ranking.decisionLogs.getByRequestId(served.requestId);
    if (log === null || log.replay_inputs === null) throw new Error('no ranked log');
    // Re-insert the log under a new id with a TAMPERED profile snapshot
    // (decision-time weights differ from what produced the ordering).
    const tampered = {
      ...log,
      request_id: randomUUID(),
      replay_inputs: {
        ...log.replay_inputs,
        profile_snapshot: {
          ...log.replay_inputs.profile_snapshot,
          // Zero out the positive weights' effect by changing the curve.
          decay_curves: {
            breaking: { half_life_hours: 0.01 },
            evergreen: { half_life_hours: 0.01 },
          },
        },
      },
    };
    await fixture.ranking.decisionLogs.insert(tampered);
    const result = await replayDecision(fixture.ranking, tampered.request_id);
    expect(result.match).toBe(false);
    expect(result.diff.length).toBeGreaterThan(0);
    expect(result.diff[0]).toHaveProperty('expected_position');
    expect(result.diff[0]).toHaveProperty('actual_position');
    expect(result.diff[0]).toHaveProperty('score_diff');
  });

  it('fallback decisions verify structural invariants', async () => {
    await seedStory(fixture.ingestion);
    const served = await serveFeed(fixture.ranking, {
      userId: null,
      surface: 'front_page',
      surfaceRoomId: null,
      surfaceTopicId: null,
      mode: 'chronological',
    });
    const result = await replayDecision(fixture.ranking, served.requestId);
    expect(result.match).toBe(true);
  });

  it('reports a missing decision log', async () => {
    const result = await replayDecision(fixture.ranking, randomUUID());
    expect(result.match).toBe(false);
    expect(result.problems).toContain('decision log not found');
  });
});

describe('runtime config (fail-closed + 422 validation)', () => {
  it('loads defaults; invalid stored values are rejected and defaults kept', async () => {
    await fixture.events.configStore.set('ranking.scalars', {
      decision_log_retention_days: 9999, // out of the §22.4 window
    });
    const rejected: string[] = [];
    const services = { ...fixture.events, log: (e: string) => rejected.push(e) };
    const config = await loadRankingRuntimeConfig(services as typeof fixture.events);
    expect(config.decisionLogRetentionDays).toBe(DEFAULT_RANKING_CONFIG.decisionLogRetentionDays);
    expect(rejected).toContain('ranking.config.rejected');
  });

  it('applies valid stored scalars and profiles', async () => {
    await fixture.events.configStore.set('ranking.scalars', {
      decision_log_retention_days: 200,
      replay_sample_size: 7,
    });
    await fixture.events.configStore.set('ranking.profiles', {
      profiles: [EVERGREEN_PROFILE],
    });
    const config = await loadRankingRuntimeConfig(fixture.events);
    expect(config.decisionLogRetentionDays).toBe(200);
    expect(config.replaySampleSize).toBe(7);
    expect(config.profiles).toHaveLength(1);
  });

  it('pre-write validation rejects invalid values (the 422 path)', () => {
    expect(
      validateRankingConfigValue('ranking.scalars', { replay_sample_size: -1 }),
    ).not.toBeNull();
    expect(
      validateRankingConfigValue('ranking.profiles', {
        profiles: [{ ...EVERGREEN_PROFILE, weights: { ...EVERGREEN_PROFILE.weights, wA: 99 } }],
      }),
    ).not.toBeNull();
    expect(validateRankingConfigValue('ranking.scalars', { replay_sample_size: 5 })).toBeNull();
  });
});

describe('admin surface (WS-I.2.5c / WS-I.4.1a; steward + MFA, meta-audited)', () => {
  let auditedTypes: string[];

  beforeEach(() => {
    // Capture every audit append so the meta-audit assertions read the
    // exact event types written (the store itself is append-only).
    auditedTypes = [];
    const original = fixture.identity.audit.append.bind(fixture.identity.audit);
    fixture.identity.audit.append = async (input, createdAt) => {
      auditedTypes.push(input.eventType);
      return original(input, createdAt);
    };
  });

  async function stewardApp() {
    const steward = await seedUserWithSession(fixture.identity, { steward: true });
    const app = new Hono().route('/v1', createV1Routes());
    return { app, steward };
  }

  it('denies non-steward access', async () => {
    const user = await seedUserWithSession(fixture.identity);
    const app = new Hono().route('/v1', createV1Routes());
    const response = await app.request('/v1/ranking/admin/decisions', {
      headers: { cookie: user.cookie },
    });
    expect(response.status).toBe(403);
  });

  it('queries decisions by the audit dimensions and meta-audits the query', async () => {
    await seedStory(fixture.ingestion);
    const served = await serveFeed(fixture.ranking, {
      userId: null,
      surface: 'front_page',
      surfaceRoomId: null,
      surfaceTopicId: null,
      mode: undefined,
    });
    const { app, steward } = await stewardApp();
    const response = await app.request(
      `/v1/ranking/admin/decisions?item_id=${(await fixture.ranking.decisionLogs.getByRequestId(served.requestId))?.candidate_ids[0]}`,
      { headers: { cookie: steward.cookie } },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { decisions: Array<{ request_id: string }> };
    expect(body.decisions.map((d) => d.request_id)).toContain(served.requestId);
    // The meta-audit landed (WS-I.2.5c: every query is itself audited).
    expect(auditedTypes).toContain('ranking_decision_query');
  });

  it('engages and releases the kill switch through the audited route', async () => {
    const { app, steward } = await stewardApp();
    const engage = await app.request('/v1/ranking/admin/killswitch', {
      method: 'PUT',
      headers: { cookie: steward.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'engage',
        global: true,
        owner: 'oncall',
        trigger_condition: 'drill',
        rollback_path: 'release via this route',
        review_date: new Date().toISOString(),
      }),
    });
    expect(engage.status).toBe(200);
    expect((await killSwitchDecision(fixture.events, 'front_page', 'evergreen')).engaged).toBe(
      true,
    );
    const release = await app.request('/v1/ranking/admin/killswitch', {
      method: 'PUT',
      headers: { cookie: steward.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'release' }),
    });
    expect(release.status).toBe(200);
    expect((await killSwitchDecision(fixture.events, 'front_page', 'evergreen')).engaged).toBe(
      false,
    );
    const empty = await app.request('/v1/ranking/admin/killswitch', {
      method: 'PUT',
      headers: { cookie: steward.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'engage',
        global: false,
        owner: 'oncall',
        trigger_condition: 'no scope',
        rollback_path: 'n/a',
        review_date: new Date().toISOString(),
      }),
    });
    expect(empty.status).toBe(422);
  });

  it('rejects invalid config writes with 422 (never lands)', async () => {
    const { app, steward } = await stewardApp();
    const bad = await app.request('/v1/ranking/admin/config', {
      method: 'PUT',
      headers: { cookie: steward.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'ranking.scalars', value: { replay_sample_size: -5 } }),
    });
    expect(bad.status).toBe(422);
    expect(await fixture.events.configStore.get('ranking.scalars')).toBeNull();
    const good = await app.request('/v1/ranking/admin/config', {
      method: 'PUT',
      headers: { cookie: steward.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'ranking.scalars', value: { replay_sample_size: 9 } }),
    });
    expect(good.status).toBe(200);
    expect(fixture.ranking.config().replaySampleSize).toBe(9);
  });

  it('serves replay + profiles + health', async () => {
    await seedStory(fixture.ingestion);
    const served = await serveFeed(fixture.ranking, {
      userId: null,
      surface: 'front_page',
      surfaceRoomId: null,
      surfaceTopicId: null,
      mode: undefined,
    });
    const { app, steward } = await stewardApp();
    const replay = await app.request(`/v1/ranking/admin/replay/${served.requestId}`, {
      method: 'POST',
      headers: { cookie: steward.cookie },
    });
    expect(replay.status).toBe(200);
    expect(((await replay.json()) as { replay: { match: boolean } }).replay.match).toBe(true);
    const profiles = await app.request('/v1/ranking/admin/profiles', {
      headers: { cookie: steward.cookie },
    });
    const profileBody = (await profiles.json()) as { profiles: Array<{ profile_id: string }> };
    expect(profileBody.profiles.map((p) => p.profile_id).sort()).toEqual([
      'breaking_news',
      'evergreen',
    ]);
    const health = await app.request('/v1/ranking/admin/health', {
      headers: { cookie: steward.cookie },
    });
    const healthBody = (await health.json()) as {
      decision_logs: number;
      retrievers: string[];
      killswitch_engaged: boolean;
    };
    expect(healthBody.decision_logs).toBe(1);
    // Eight organic SPEC §13.2 sources + the room-surface scoper.
    expect(healthBody.retrievers).toHaveLength(9);
    expect(healthBody.killswitch_engaged).toBe(false);
  });
});

describe('maintenance scheduler (lease-guarded tick)', () => {
  it('refreshes features, sweeps expired logs, and replay-samples', async () => {
    await seedStory(fixture.ingestion);
    const served = await serveFeed(fixture.ranking, {
      userId: null,
      surface: 'front_page',
      surfaceRoomId: null,
      surfaceTopicId: null,
      mode: undefined,
    });
    expect(await fixture.ranking.decisionLogs.count()).toBe(1);
    // Sweep at a time past the retention deadline removes the log.
    const farFuture = Date.now() + 400 * 24 * 3_600_000;
    await runRankingTick(fixture.ranking, () => {}, farFuture);
    expect(await fixture.ranking.decisionLogs.count()).toBe(0);
    void served;
  });

  it('task errors are isolated per task (one failure never stops the tick)', async () => {
    const errors: string[] = [];
    const broken = {
      ...fixture.ranking,
      reloadConfig: async () => {
        throw new Error('config outage');
      },
    };
    await runRankingTick(broken as typeof fixture.ranking, (_err, task) => errors.push(task));
    expect(errors).toEqual(['config_reload']);
  });
});
