// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-H route tests: steward gating on the admin surface, the promotion
// endpoint (checklist 422s, promotion → demotion round trip, audit), the
// validated config write (422 at configuration time, audit), the MFCI
// analyst queue + resolve path (clearing lifts the safety freeze; audited),
// the version-comparison query, the GWEI transparency export shape, and
// the public SCOI/MERI read surfaces (404-over-403 on hidden stories).
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { hourWindow } from '../invariants/runner.js';
import { createV1Routes } from '../routes/v1.js';
import {
  freshWsHServices,
  seedStory,
  seedUserWithSession,
  type WsHFixture,
} from './ws-h-helpers.js';

function app() {
  // Bare v1 mounting (the house admin-test pattern): the CSRF/CORS layers
  // have their own dedicated suites.
  return new Hono().route('/v1', createV1Routes());
}

async function adminRequest(
  fixture: WsHFixture,
  cookie: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  void fixture;
  return app().request(`http://local/v1/invariants/admin${path}`, {
    ...init,
    headers: {
      cookie,
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
}

describe('steward gating', () => {
  it('rejects anonymous and non-steward access', async () => {
    const fixture = freshWsHServices();
    const anonymous = await app().request('http://local/v1/invariants/admin/health');
    expect(anonymous.status).toBe(401);
    const user = await seedUserWithSession(fixture.identity);
    const nonSteward = await adminRequest(fixture, user.cookie, '/health');
    expect(nonSteward.status).toBe(403);
  });
});

describe('health + outputs + comparison', () => {
  it('reports all eleven invariants with cards, tiers, and shadow status', async () => {
    const fixture = freshWsHServices();
    const steward = await seedUserWithSession(fixture.identity, { steward: true });
    const response = await adminRequest(fixture, steward.cookie, '/health');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { invariants: Array<Record<string, unknown>> };
    expect(body.invariants).toHaveLength(11);
    for (const entry of body.invariants) {
      expect(entry['shadow_status']).toBe('shadow');
      expect(entry['card']).toBeTruthy();
    }
  });

  it('version comparison returns paired outputs filtered by window (WS-H.1.1b)', async () => {
    const fixture = freshWsHServices();
    const steward = await seedUserWithSession(fixture.identity, { steward: true });
    const targetId = randomUUID();
    const window = { start: '2026-06-10T00:00:00.000Z', end: '2026-06-10T01:00:00.000Z' };
    const base = {
      invariantType: 'SCOI',
      targetType: 'story',
      targetId,
      timeWindow: window,
      scoreVector: {
        scoi: 0.2,
        normalizer: 4,
        overlap_count: 1,
        lens_count: 2,
        context_state: 'ambiguous',
        per_overlap_energy: {},
      },
      explanationSummary: null,
      confidence: 0.8,
      coverage: 1,
      reasonCodes: [],
      fallbackUsed: false,
      versionMetadata: null,
      shadowMode: true,
      createdAt: new Date().toISOString(),
    };
    await fixture.events.invariantStore.upsert({ ...base, version: '1.0.0' });
    await fixture.events.invariantStore.upsert({ ...base, version: '1.1.0' });
    // An out-of-window row must be filtered.
    await fixture.events.invariantStore.upsert({
      ...base,
      version: '1.1.0',
      timeWindow: { start: '2026-06-12T00:00:00.000Z', end: '2026-06-12T01:00:00.000Z' },
    });
    const response = await adminRequest(
      fixture,
      steward.cookie,
      `/compare?invariant_type=SCOI&version_a=1.0.0&version_b=1.1.0&from=${encodeURIComponent(
        window.start,
      )}&to=${encodeURIComponent(window.end)}`,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { outputs: Array<{ version: string }> };
    expect(body.outputs).toHaveLength(2);
    expect(body.outputs.map((o) => o.version).sort()).toEqual(['1.0.0', '1.1.0']);
  });
});

describe('promotion endpoint (WS-H.1.2e)', () => {
  const evidence = {
    shadow_duration_days: 30,
    drift_report_ref: 'regression-2026-06-10',
    observed_coverage: 0.95,
    observed_confidence: 0.9,
  };

  it('rejects an under-evidenced promotion with 422 and applies a valid one', async () => {
    const fixture = freshWsHServices();
    const steward = await seedUserWithSession(fixture.identity, { steward: true });
    const rejected = await adminRequest(fixture, steward.cookie, '/promotions', {
      method: 'POST',
      body: JSON.stringify({
        invariant_type: 'MERI',
        from_status: 'shadow',
        to_status: 'soft_constraint',
        evidence: { ...evidence, shadow_duration_days: 1 },
        owner: 'ranking-lead',
      }),
    });
    expect(rejected.status).toBe(422);

    const applied = await adminRequest(fixture, steward.cookie, '/promotions', {
      method: 'POST',
      body: JSON.stringify({
        invariant_type: 'MERI',
        from_status: 'shadow',
        to_status: 'soft_constraint',
        evidence,
        owner: 'ranking-lead',
      }),
    });
    expect(applied.status).toBe(200);
    expect(((await applied.json()) as { shadow_status: string }).shadow_status).toBe(
      'soft_constraint',
    );

    // Kill switch: demote back without any evidence threshold.
    const demoted = await adminRequest(fixture, steward.cookie, '/promotions', {
      method: 'POST',
      body: JSON.stringify({
        invariant_type: 'MERI',
        from_status: 'soft_constraint',
        to_status: 'shadow',
        evidence: { ...evidence, shadow_duration_days: 0, drift_report_ref: 'incident-1' },
        owner: 'oncall',
      }),
    });
    expect(demoted.status).toBe(200);
    const history = await adminRequest(fixture, steward.cookie, '/promotions/MERI');
    const historyBody = (await history.json()) as {
      shadow_status: string;
      history: unknown[];
    };
    expect(historyBody.shadow_status).toBe('shadow');
    expect(historyBody.history).toHaveLength(2);
    // The audit append runs inside the request path (a failing append would
    // 500); the append-only history above IS the durable record.
  });
});

describe('config endpoint (fail closed)', () => {
  it('422s invalid values at configuration time and applies valid ones', async () => {
    const fixture = freshWsHServices();
    const steward = await seedUserWithSession(fixture.identity, { steward: true });
    const invalid = await adminRequest(fixture, steward.cookie, '/config', {
      method: 'PUT',
      body: JSON.stringify({ key: 'invariants.batchConcurrency', value: 99 }),
    });
    expect(invalid.status).toBe(422);
    const unknown = await adminRequest(fixture, steward.cookie, '/config', {
      method: 'PUT',
      body: JSON.stringify({ key: 'invariants.nope', value: 1 }),
    });
    expect(unknown.status).toBe(422);
    const valid = await adminRequest(fixture, steward.cookie, '/config', {
      method: 'PUT',
      body: JSON.stringify({ key: 'invariants.batchConcurrency', value: 4 }),
    });
    expect(valid.status).toBe(200);
    expect(fixture.invariants.config().batchConcurrency).toBe(4);
  });
});

describe('MFCI analyst queue (WS-H.3.4b) + freeze clearing (WS-H.3.3d)', () => {
  it('resolving a case as cleared lifts the safety freeze and audits the actor', async () => {
    const fixture = freshWsHServices();
    const steward = await seedUserWithSession(fixture.identity, { steward: true });
    const { storyId } = await seedStory(fixture);
    // Frozen item + open case.
    await fixture.events.safetyStore.set({
      itemId: storyId,
      safetyState: 'frozen',
      frozenScore: 0.4,
      caseId: randomUUID(),
      updatedBy: 'system:harassment_cascade',
      updatedAt: new Date().toISOString(),
    });
    const caseId = randomUUID();
    await fixture.invariants.mfciCases.insert({
      caseId,
      targetType: 'story',
      targetId: storyId,
      riskState: 'high',
      statistic: 'target_concentration',
      mfciScore: 6,
      pHat: 0.002,
      sampleCount: 1000,
      fixedMarginsRef: 'margins:test',
      summary: 'Coordination signal',
      appealSummary: 'What was detected: …',
      status: 'open',
      openedAt: new Date().toISOString(),
      resolvedAt: null,
      resolvedBy: null,
    });
    const dashboard = await adminRequest(fixture, steward.cookie, '/mfci/dashboard');
    expect(dashboard.status).toBe(200);
    expect(((await dashboard.json()) as { open_cases: unknown[] }).open_cases).toHaveLength(1);

    // The held risk state from the detection that opened the case.
    await fixture.invariants.mfciRiskStates.set({
      targetId: storyId,
      state: 'high',
      score: 6,
      reason: 'score',
      updatedAt: new Date().toISOString(),
    });

    const resolved = await adminRequest(fixture, steward.cookie, `/mfci/cases/${caseId}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ action: 'cleared' }),
    });
    expect(resolved.status).toBe(200);
    // The freeze lifted (WS-H.3.3d: clearing melts the freeze) and the
    // resolver is attributed on the safety state (steward actor).
    const state = await fixture.events.safetyStore.get(storyId);
    expect(state?.safetyState).toBe('normal');
    expect(state?.updatedBy).toBe(`steward:${steward.userId}`);
    // Analyst clearing is the override evidence that releases the HELD
    // risk state downward (WS-H.3.4a).
    const risk = await fixture.invariants.mfciRiskStates.get(storyId);
    expect(risk?.state).toBe('normal');
    expect(risk?.reason).toBe('analyst_override');
    // Re-resolving 404s (single-shot lifecycle).
    const again = await adminRequest(fixture, steward.cookie, `/mfci/cases/${caseId}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ action: 'confirmed' }),
    });
    expect(again.status).toBe(404);
  });

  it('a fixed_margins_ref dereferences to the persisted conditioning (MFCI-4)', async () => {
    const fixture = freshWsHServices();
    const steward = await seedUserWithSession(fixture.identity, { steward: true });
    await fixture.invariants.mfciMargins.put({
      marginsRef: 'margins:2026-06-11T00:00:00.000Z:abc123',
      windowStart: '2026-06-11T00:00:00.000Z',
      margins: {
        axes: ['user_group', 'topic', 'time_bucket', 'action_type', 'target'],
        margins: [[5, 3]],
        total: 8,
      },
      createdAt: new Date().toISOString(),
    });
    const found = await adminRequest(
      fixture,
      steward.cookie,
      '/mfci/margins/margins:2026-06-11T00:00:00.000Z:abc123',
    );
    expect(found.status).toBe(200);
    const body = (await found.json()) as { margins: { margins: { total: number } } };
    expect(body.margins.margins.total).toBe(8);
    const missing = await adminRequest(fixture, steward.cookie, '/mfci/margins/margins:absent');
    expect(missing.status).toBe(404);
  });
});

describe('GWEI transparency export (WS-H.5.2d)', () => {
  it('publishes parity statements only — no cohort metrics, no suppressed detail', async () => {
    const fixture = freshWsHServices();
    const steward = await seedUserWithSession(fixture.identity, { steward: true });
    const window = hourWindow(Date.now());
    await fixture.events.invariantStore.upsert({
      invariantType: 'GWEI',
      targetType: 'cohort',
      targetId: randomUUID(),
      timeWindow: window,
      version: '1.0.0',
      scoreVector: {
        gw2: 0.2,
        ci_low: 0.18,
        ci_high: 0.25,
        seed_count: 3,
        regularization: 0.01,
        cohort_a: 'locale:en',
        cohort_b: 'locale:es',
        metric_breakdown: { a_sourceDiversity: 3.2 },
      },
      explanationSummary: null,
      confidence: 0.8,
      coverage: 1,
      reasonCodes: [],
      fallbackUsed: false,
      versionMetadata: null,
      shadowMode: true,
      createdAt: new Date().toISOString(),
    });
    await fixture.events.invariantStore.upsert({
      invariantType: 'GWEI',
      targetType: 'cohort',
      targetId: randomUUID(),
      timeWindow: window,
      version: '1.0.0',
      scoreVector: {},
      explanationSummary: null,
      confidence: 0,
      coverage: 0,
      reasonCodes: ['SUPPRESSED_K_ANONYMITY'],
      fallbackUsed: false,
      versionMetadata: null,
      shadowMode: true,
      createdAt: new Date().toISOString(),
    });
    const response = await adminRequest(fixture, steward.cookie, '/gwei/transparency');
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      statements: Array<{ status: string }>;
    };
    expect(body.statements).toHaveLength(2);
    expect(body.statements.map((s) => s.status).sort()).toEqual([
      'parity_within_threshold',
      'withheld_small_cohort',
    ]);
    // No cohort keys or metric values leak into the export.
    expect(JSON.stringify(body)).not.toContain('locale:');
    expect(JSON.stringify(body)).not.toContain('sourceDiversity');
  });
});

describe('public WS-H read surfaces', () => {
  it('interpretations 404 on hidden stories and answer empty before SCOI runs', async () => {
    const fixture = freshWsHServices();
    const { storyId } = await seedStory(fixture);
    const empty = await app().request(`http://local/v1/stories/${storyId}/interpretations`);
    expect(empty.status).toBe(200);
    const body = (await empty.json()) as { interpretations: unknown[]; needs_context: boolean };
    expect(body.interpretations).toEqual([]);
    expect(body.needs_context).toBe(false);

    await fixture.ingestion.stories.update(storyId, { hiddenState: 'takedown' });
    const hidden = await app().request(`http://local/v1/stories/${storyId}/interpretations`);
    expect(hidden.status).toBe(404);
    const missing = await app().request(
      `http://local/v1/stories/${randomUUID()}/independent-sources`,
    );
    expect(missing.status).toBe(404);
  });

  it('the independent-sources drawer serves lineage context from stored data', async () => {
    const fixture = freshWsHServices();
    const wire = await fixture.ingestion.sources.upsertByDomain('wire.example', { name: 'Wire' });
    const { storyId } = await seedStory(fixture, {
      canonicalUrl: 'https://wire.example/a',
      sourceId: wire.sourceId,
    });
    const response = await app().request(`http://local/v1/stories/${storyId}/independent-sources`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      source: { name: string } | null;
      marginal_gain: number | null;
    };
    expect(body.source?.name).toBe('Wire');
    expect(body.marginal_gain).toBeNull(); // no MERI run yet — honestly absent
  });
});

describe('SCOI context surfaces (WS-H.4.1c/4.2d/4.3d)', () => {
  /** A room with two lenses reading the SAME story divergently, plus a
   * multi-lens participant (the bridge candidate), with the acting user as
   * the room's steward. */
  async function seedSplitRoom(fixture: WsHFixture, stewardUserId: string) {
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
    await fixture.forum.rooms.addSteward({
      roomId,
      userId: stewardUserId,
      role: 'community_steward',
      assignedAt: new Date().toISOString(),
    });
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
    const { storyId, threadId } = await seedStory(fixture);
    await fixture.ingestion.stories.updateThread(threadId, { roomId });
    const bridgeUser = await seedUserWithSession(fixture.identity);
    const bodies: Record<string, string> = {
      [lensIds[0] ?? '']: 'Routine harmless maintenance notice nothing unusual here at all.',
      [lensIds[1] ?? '']: 'Critical alarming contamination emergency requiring immediate action.',
    };
    for (const lensId of lensIds) {
      const result = await fixture.forum.contributions.insert({
        contributionId: randomUUID(),
        threadId,
        userId: bridgeUser.userId, // posts under BOTH lenses → bridge candidate
        type: 'explanation',
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
    return { roomId, storyId, threadId, lensIds, bridgeUserId: bridgeUser.userId };
  }

  it('steward reports are room-scoped with states, lenses, and recommendations', async () => {
    const fixture = freshWsHServices();
    const steward = await seedUserWithSession(fixture.identity, { steward: true });
    const { roomId, storyId, threadId } = await seedSplitRoom(fixture, steward.userId);
    // Store a SCOI output so the report has a measurement to show.
    await fixture.invariants.scoi
      .computeBatch([{ targetType: 'story', targetId: storyId }], hourWindow(Date.now()))
      .then((outputs) =>
        Promise.all(
          outputs.map((o) =>
            fixture.events.invariantStore.upsert({
              invariantType: o.invariantType,
              targetType: o.target.targetType,
              targetId: o.target.targetId,
              timeWindow: o.window,
              version: o.version,
              scoreVector: o.score_vector,
              explanationSummary: o.explanationSummary,
              confidence: o.confidence,
              coverage: o.coverage,
              reasonCodes: o.reason_codes,
              fallbackUsed: o.fallback_used,
              versionMetadata: null,
              shadowMode: true,
              createdAt: new Date().toISOString(),
            }),
          ),
        ),
      );
    const report = await adminRequest(fixture, steward.cookie, `/scoi/reports/${roomId}`);
    expect(report.status).toBe(200);
    const body = (await report.json()) as {
      reports: Array<{
        story_id: string;
        thread_id: string;
        context_state: string;
        scoi: number;
        lenses: Array<{ name: string; contribution_count: number }>;
        recommended_actions: string[];
        bridge_attempts: unknown[];
      }>;
    };
    expect(body.reports).toHaveLength(1);
    const entry = body.reports[0];
    expect(entry?.story_id).toBe(storyId);
    expect(entry?.thread_id).toBe(threadId);
    expect(entry?.lenses).toHaveLength(2);
    expect(typeof entry?.scoi).toBe('number');
    // An OUT-OF-SCOPE steward (global role, not a room steward) gets 404.
    const outsider = await seedUserWithSession(fixture.identity, { steward: true });
    const denied = await adminRequest(fixture, outsider.cookie, `/scoi/reports/${roomId}`);
    expect(denied.status).toBe(404);
  });

  it('annotation measurably reduces SCOI and is audited with a ratified code (SCOI-4)', async () => {
    const fixture = freshWsHServices();
    const steward = await seedUserWithSession(fixture.identity, { steward: true });
    const { storyId, threadId } = await seedSplitRoom(fixture, steward.userId);
    // Baseline measurement (stored so the action has a before).
    const baseline = await fixture.invariants.scoi.computeBatch(
      [{ targetType: 'story', targetId: storyId }],
      hourWindow(Date.now()),
    );
    const scoiBefore = baseline[0]?.score_vector['scoi'] as number;
    expect(scoiBefore).toBeGreaterThan(0);
    await fixture.events.invariantStore.upsert({
      invariantType: 'SCOI',
      targetType: 'story',
      targetId: storyId,
      timeWindow: hourWindow(Date.now()),
      version: '1.0.0',
      scoreVector: baseline[0]?.score_vector ?? {},
      explanationSummary: null,
      confidence: 0.8,
      coverage: 1,
      reasonCodes: [],
      fallbackUsed: false,
      versionMetadata: null,
      shadowMode: true,
      createdAt: new Date().toISOString(),
    });
    // A fabricated reason code is refused (422).
    const fabricated = await adminRequest(
      fixture,
      steward.cookie,
      `/scoi/threads/${threadId}/actions`,
      {
        method: 'POST',
        body: JSON.stringify({
          action: 'annotate',
          reason_code: 'MADE_UP_001',
          annotation: 'Shared context.',
        }),
      },
    );
    expect(fabricated.status).toBe(422);
    // The real annotation: identical shared context lands on BOTH lenses,
    // pulling the interpretation vectors together.
    const acted = await adminRequest(fixture, steward.cookie, `/scoi/threads/${threadId}/actions`, {
      method: 'POST',
      body: JSON.stringify({
        action: 'annotate',
        reason_code: 'MOD_MISINFO_001',
        annotation:
          'Officials confirmed this is a scheduled maintenance notice; the contamination figures referenced were from the 2019 incident report.',
      }),
    });
    expect(acted.status).toBe(200);
    const result = (await acted.json()) as {
      action_id: string;
      scoi_before: number;
      scoi_after: number;
    };
    // The ACCEPTANCE criterion: annotation reduces SCOI on re-computation.
    expect(result.scoi_after).toBeLessThan(result.scoi_before);
    const actions = await fixture.invariants.scoiActions.listForThread(threadId, 5);
    expect(actions).toHaveLength(1);
    expect(actions[0]?.reasonCode).toBe('MOD_MISINFO_001');
    expect(actions[0]?.actorRef).toBe(`steward:${steward.userId}`);
  });

  it('bridge requests route multi-lens candidates; a reducing contribution credits (SCOI-2)', async () => {
    const fixture = freshWsHServices();
    const steward = await seedUserWithSession(fixture.identity, { steward: true });
    const { threadId, lensIds, bridgeUserId } = await seedSplitRoom(fixture, steward.userId);
    const opened = await adminRequest(
      fixture,
      steward.cookie,
      `/scoi/threads/${threadId}/bridge-requests`,
      { method: 'POST', body: JSON.stringify({}) },
    );
    expect(opened.status).toBe(200);
    const request = (await opened.json()) as {
      attempt_id: string;
      scoi_baseline: number;
      candidates: string[];
    };
    expect(request.scoi_baseline).toBeGreaterThan(0);
    // The multi-lens participant is the routed candidate.
    expect(request.candidates).toContain(bridgeUserId);
    // A second open request 409s (one at a time per thread).
    const duplicate = await adminRequest(
      fixture,
      steward.cookie,
      `/scoi/threads/${threadId}/bridge-requests`,
      { method: 'POST', body: JSON.stringify({}) },
    );
    expect(duplicate.status).toBe(409);
    // The bridge contribution: the SAME shared context under both lenses,
    // then the durable consumer measures the decrease and credits.
    for (const lensId of lensIds) {
      const inserted = await fixture.forum.contributions.insert({
        contributionId: randomUUID(),
        threadId,
        userId: bridgeUserId,
        type: 'local_context',
        body: 'Both readings reference the same scheduled maintenance bulletin from the city.',
        citations: [],
        metadata: { lens_id: lensId },
        targetClaimId: null,
        parentContributionId: null,
        clientDraftId: randomUUID(),
        path: [],
        moderationState: 'published',
      });
      expect(inserted.ok).toBe(true);
      if (inserted.ok) {
        await fixture.events.router.publish({
          event_id: randomUUID(),
          event_type: 'contribution.created',
          timestamp: new Date().toISOString(),
          schema_version: '1',
          thread_id: threadId,
          contribution_id: inserted.contribution.contributionId,
          user_id: bridgeUserId,
          contribution_type: 'local_context',
          privacy_classification: 'public',
          retention_tier: 'public_contribution',
        } as never);
      }
    }
    const attempts = await fixture.invariants.bridgeAttempts.listForThread(threadId, 5);
    const credited = attempts.find((a) => a.status === 'credited');
    expect(credited).toBeDefined();
    expect(credited?.bridgeUserId).toBe(bridgeUserId);
    expect(credited?.scoiAfter).toBeLessThan(request.scoi_baseline);
    // SCOI-2 participation credit: the DESCRIPTIVE reputation summary.
    const user = await fixture.identity.store.getUser(bridgeUserId);
    expect(user?.reputationSummary.bridge_ability).toBe(1);
    // Single-shot: only one credit even though two contributions arrived.
    expect(attempts.filter((a) => a.status === 'credited')).toHaveLength(1);
  });

  it('a moderator annotation rebaselines the open request — credit is never inherited', async () => {
    const fixture = freshWsHServices();
    const steward = await seedUserWithSession(fixture.identity, { steward: true });
    const { threadId, lensIds, bridgeUserId } = await seedSplitRoom(fixture, steward.userId);
    const opened = await adminRequest(
      fixture,
      steward.cookie,
      `/scoi/threads/${threadId}/bridge-requests`,
      { method: 'POST', body: JSON.stringify({}) },
    );
    expect(opened.status).toBe(200);
    const { scoi_baseline } = (await opened.json()) as { scoi_baseline: number };
    // The STEWARD annotation lowers SCOI (shared context on both lenses)…
    const acted = await adminRequest(fixture, steward.cookie, `/scoi/threads/${threadId}/actions`, {
      method: 'POST',
      body: JSON.stringify({
        action: 'annotate',
        reason_code: 'MOD_MISINFO_001',
        annotation:
          'City bulletin: the figures describe the 2019 incident, not current conditions; both readings reference the same maintenance schedule.',
      }),
    });
    expect(acted.status).toBe(200);
    const { scoi_after } = (await acted.json()) as { scoi_after: number };
    expect(scoi_after).toBeLessThan(scoi_baseline);
    // …and the open attempt's baseline follows it, so the decrease the
    // moderator caused cannot be claimed by the next contribution.
    const open = await fixture.invariants.bridgeAttempts.openForThread(threadId);
    expect(open?.scoiBaseline).toBe(scoi_after);
    // A contribution that does NOT further reduce the energy (it restates
    // one lens's reading) gets no credit.
    const inserted = await fixture.forum.contributions.insert({
      contributionId: randomUUID(),
      threadId,
      userId: bridgeUserId,
      type: 'explanation',
      body: 'Routine harmless maintenance notice nothing unusual here at all.',
      citations: [],
      metadata: { lens_id: lensIds[0] ?? '' },
      targetClaimId: null,
      parentContributionId: null,
      clientDraftId: randomUUID(),
      path: [],
      moderationState: 'published',
    });
    expect(inserted.ok).toBe(true);
    if (inserted.ok) {
      await fixture.events.router.publish({
        event_id: randomUUID(),
        event_type: 'contribution.created',
        timestamp: new Date().toISOString(),
        schema_version: '1',
        thread_id: threadId,
        contribution_id: inserted.contribution.contributionId,
        user_id: bridgeUserId,
        contribution_type: 'explanation',
        privacy_classification: 'public',
        retention_tier: 'public_contribution',
      } as never);
    }
    const after = await fixture.invariants.bridgeAttempts.openForThread(threadId);
    expect(after?.status).toBe('requested'); // still open — no inherited credit
    const user = await fixture.identity.store.getUser(bridgeUserId);
    expect(user?.reputationSummary.bridge_ability).toBeNull();
  });

  it('merge requires the actor to steward the RELATED thread too', async () => {
    const fixture = freshWsHServices();
    const steward = await seedUserWithSession(fixture.identity, { steward: true });
    const outsider = await seedUserWithSession(fixture.identity, { steward: true });
    const mine = await seedSplitRoom(fixture, steward.userId);
    const theirs = await seedSplitRoom(fixture, outsider.userId);
    // Cross-room merge into a thread the actor does not steward: refused,
    // and nothing lands in the other room's report.
    const denied = await adminRequest(
      fixture,
      steward.cookie,
      `/scoi/threads/${mine.threadId}/actions`,
      {
        method: 'POST',
        body: JSON.stringify({
          action: 'merge',
          reason_code: 'MOD_SPAM_001',
          related_thread_id: theirs.threadId,
        }),
      },
    );
    expect(denied.status).toBe(422);
    expect(await fixture.invariants.scoiActions.listForThread(theirs.threadId, 5)).toHaveLength(0);
    // A related thread within the actor's own stewarded room is accepted
    // and the record lists from BOTH sides.
    const sibling = await seedStory(fixture);
    await fixture.ingestion.stories.updateThread(sibling.threadId, { roomId: mine.roomId });
    const merged = await adminRequest(
      fixture,
      steward.cookie,
      `/scoi/threads/${mine.threadId}/actions`,
      {
        method: 'POST',
        body: JSON.stringify({
          action: 'merge',
          reason_code: 'MOD_SPAM_001',
          related_thread_id: sibling.threadId,
        }),
      },
    );
    expect(merged.status).toBe(200);
    expect(await fixture.invariants.scoiActions.listForThread(sibling.threadId, 5)).toHaveLength(1);
  });
});

describe('WS-H client wire surfaces (feed labels, lens names, co-group)', () => {
  it('feed items carry the MERI exposure label from stored gains', async () => {
    const fixture = freshWsHServices();
    const demoId = '5f5e1000-0000-4000-8000-000000000001';
    await fixture.events.invariantStore.upsert({
      invariantType: 'MERI',
      targetType: 'feed',
      targetId: '00000000-0000-4000-8000-0000000feed1',
      timeWindow: hourWindow(Date.now()),
      version: '1.0.0',
      scoreVector: {
        meri: 0.9,
        marginal_gains: { [demoId]: 1 },
        approximation: false,
        per_class_bounds: {},
        group_ids: [],
      },
      explanationSummary: null,
      confidence: 0.9,
      coverage: 1,
      reasonCodes: [],
      fallbackUsed: false,
      versionMetadata: null,
      shadowMode: true,
      createdAt: new Date().toISOString(),
    });
    const response = await app().request('http://local/v1/feed');
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      items: Array<{ story_id: string; exposure_label: string | null }>;
    };
    const labeled = body.items.find((item) => item.story_id === demoId);
    expect(labeled?.exposure_label).toBe('independent_source');
    // Stories without a stored gain stay honestly unlabeled.
    const unlabeled = body.items.find((item) => item.story_id !== demoId);
    expect(unlabeled?.exposure_label).toBeNull();
  });

  it('interpretations resolve human lens names through the room', async () => {
    const fixture = freshWsHServices();
    const steward = await seedUserWithSession(fixture.identity, { steward: true });
    const { storyId } = await (async () => {
      const roomId = randomUUID();
      await fixture.forum.rooms.insert({
        roomId,
        name: 'Names room',
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
      const lensIds: string[] = [];
      for (const [lensType, name] of [
        ['local_resident', 'Local residents'],
        ['expert', 'Water engineers'],
      ] as const) {
        const lens = await fixture.forum.lenses.insert({
          lensId: randomUUID(),
          roomId,
          name,
          lensType,
          description: null,
        });
        if (lens.ok) lensIds.push(lens.lens.lensId);
      }
      const seeded = await seedStory(fixture);
      await fixture.ingestion.stories.updateThread(seeded.threadId, { roomId });
      for (const lensId of lensIds) {
        await fixture.forum.contributions.insert({
          contributionId: randomUUID(),
          threadId: seeded.threadId,
          userId: steward.userId,
          type: 'explanation',
          body: lensId === lensIds[0] ? 'Reads as routine here.' : 'Figures look anomalous.',
          citations: [],
          metadata: { lens_id: lensId },
          targetClaimId: null,
          parentContributionId: null,
          clientDraftId: randomUUID(),
          path: [],
          moderationState: 'published',
        });
      }
      return seeded;
    })();
    const [output] = await fixture.invariants.scoi.computeBatch(
      [{ targetType: 'story', targetId: storyId }],
      hourWindow(Date.now()),
    );
    await fixture.events.invariantStore.upsert({
      invariantType: 'SCOI',
      targetType: 'story',
      targetId: storyId,
      timeWindow: hourWindow(Date.now()),
      version: '1.0.0',
      scoreVector: output?.score_vector ?? {},
      explanationSummary: null,
      confidence: 0.8,
      coverage: 1,
      reasonCodes: [],
      fallbackUsed: false,
      versionMetadata: null,
      shadowMode: true,
      createdAt: new Date().toISOString(),
    });
    const response = await app().request(`http://local/v1/stories/${storyId}/interpretations`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      interpretations: Array<{ lens_a_name?: string; lens_b_name?: string }>;
    };
    expect(body.interpretations.length).toBeGreaterThan(0);
    const names = new Set(
      body.interpretations.flatMap((i) => [i.lens_a_name, i.lens_b_name]).filter(Boolean),
    );
    expect(names.has('Local residents')).toBe(true);
    expect(names.has('Water engineers')).toBe(true);
  });

  it('the drawer lists visible co-group stories (syndication siblings)', async () => {
    const fixture = freshWsHServices();
    const wire = await fixture.ingestion.sources.upsertByDomain('wire.example', { name: 'Wire' });
    const mirror = await fixture.ingestion.sources.upsertByDomain('mirror.example', {
      name: 'Mirror',
    });
    await fixture.ingestion.syndications.insert({
      syndicationId: randomUUID(),
      fromSourceId: wire.sourceId,
      toSourceId: mirror.sourceId,
      relationshipType: 'wire',
      establishedBy: 'steward',
      status: 'confirmed',
      evidenceRef: 'steward:confirmed',
      confidence: 1,
    });
    const { storyId } = await seedStory(fixture, {
      canonicalUrl: 'https://wire.example/report',
      sourceId: wire.sourceId,
      title: 'Original wire report',
    });
    const { storyId: copyId } = await seedStory(fixture, {
      canonicalUrl: 'https://mirror.example/report',
      sourceId: mirror.sourceId,
      title: 'Mirrored wire report',
    });
    const response = await app().request(`http://local/v1/stories/${storyId}/independent-sources`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      co_group_stories: Array<{ story_id: string; relationship: string }>;
    };
    expect(body.co_group_stories.map((m) => m.story_id)).toContain(copyId);
    expect(body.co_group_stories.find((m) => m.story_id === copyId)?.relationship).toBe(
      'syndicated',
    );
    // Hidden members never appear (visibility-gated).
    await fixture.ingestion.stories.update(copyId, { hiddenState: 'takedown' });
    const after = await app().request(`http://local/v1/stories/${storyId}/independent-sources`);
    const afterBody = (await after.json()) as { co_group_stories: Array<{ story_id: string }> };
    expect(afterBody.co_group_stories.map((m) => m.story_id)).not.toContain(copyId);
  });
});
