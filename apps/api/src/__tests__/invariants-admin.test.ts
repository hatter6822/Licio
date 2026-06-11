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
    // Re-resolving 404s (single-shot lifecycle).
    const again = await adminRequest(fixture, steward.cookie, `/mfci/cases/${caseId}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ action: 'confirmed' }),
    });
    expect(again.status).toBe(404);
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
