// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-K route surface: model-card lookup is open to any authenticated user;
// model lifecycle is AI-team gated; the review queue is steward gated;
// translation + reports work for any authenticated user.
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { seedAiGovernance } from '../ai-governance/seed.js';
import {
  type AiGovernanceServices,
  createInMemoryAiGovernanceServices,
  setAiGovernanceServices,
} from '../ai-governance/services.js';
import { createAiGovernanceAdminRoutes } from '../routes/ai-governance-admin.js';
import { createAiGovernancePublicRoutes } from '../routes/ai-governance-public.js';
import { freshForumServices, seedUserWithSession } from './forum-test-helpers.js';

function buildApp() {
  return new Hono()
    .route('/v1/ai/admin', createAiGovernanceAdminRoutes())
    .route('/v1', createAiGovernancePublicRoutes());
}

function jsonReq(path: string, method: string, body: unknown, cookie?: string): Request {
  const init: RequestInit = {
    method,
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
    },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  return new Request(`http://localhost${path}`, init);
}

describe('WS-K routes', () => {
  let forum: ReturnType<typeof freshForumServices>;
  let ai: AiGovernanceServices;
  let app: ReturnType<typeof buildApp>;

  beforeEach(async () => {
    forum = freshForumServices();
    ai = createInMemoryAiGovernanceServices(forum.events);
    ai.ingestion = forum.ingestion;
    ai.forum = forum.forum;
    setAiGovernanceServices(ai);
    await seedAiGovernance(ai);
    app = buildApp();
  });

  it('lets any authenticated user look up model cards', async () => {
    const user = await seedUserWithSession(forum.identity);
    const res = await app.request(
      jsonReq('/v1/ai/models?status=deployed', 'GET', undefined, user.cookie),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { models: Array<{ name: string }> };
    expect(body.models.length).toBeGreaterThan(0);
    expect(body.models.some((m) => m.name === 'topic-classifier')).toBe(true);
  });

  it('rejects an unauthenticated lookup', async () => {
    const res = await app.request(jsonReq('/v1/ai/models', 'GET', undefined));
    expect(res.status).toBe(401);
  });

  it('gates the AI-team admin surface to the AI team', async () => {
    const regular = await seedUserWithSession(forum.identity);
    const steward = await seedUserWithSession(forum.identity, { steward: true });
    const aiTeam = await seedUserWithSession(forum.identity, { admin: true });

    expect(
      (await app.request(jsonReq('/v1/ai/admin/inventory', 'GET', undefined, regular.cookie)))
        .status,
    ).toBe(403);
    // A steward is NOT on the AI team.
    expect(
      (await app.request(jsonReq('/v1/ai/admin/inventory', 'GET', undefined, steward.cookie)))
        .status,
    ).toBe(403);
    const ok = await app.request(
      jsonReq('/v1/ai/admin/inventory', 'GET', undefined, aiTeam.cookie),
    );
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { inventory: { use_cases: unknown[] } };
    // The nine canonical use cases (the eight WS-K + the WS-T debate adjudicator).
    expect(body.inventory.use_cases).toHaveLength(9);
  });

  it('serves the boot-resolved governed-LLM lane status to the AI team (WS-U ADR-9 observability)', async () => {
    const aiTeam = await seedUserWithSession(forum.identity, { admin: true });
    const regular = await seedUserWithSession(forum.identity);

    // Unset (a test boot that wired no decision) answers null, never a 500.
    const unset = await app.request(
      jsonReq('/v1/ai/admin/governance/llm', 'GET', undefined, aiTeam.cookie),
    );
    expect(unset.status).toBe(200);
    expect(await unset.json()).toEqual({ status: null });

    ai.llmStatus = {
      enabled: true,
      providerDefaulted: true,
      lanes: {
        moderation: {
          role: 'moderation',
          backend: 'local',
          modelId: 'licio-governance-sim',
          baseUrl: 'http://127.0.0.1:3117/v1',
          simulated: true,
          format: 'json',
          surfaces: [{ surface: 'moderation', active: true, fallback: 'platform_baseline' }],
        },
        adjudication: {
          role: 'adjudication',
          backend: 'local',
          modelId: 'Qwen/Qwen3.6-27B',
          baseUrl: 'http://127.0.0.1:8002/v1',
          simulated: false,
          format: null,
          surfaces: [
            { surface: 'debate', active: true, fallback: 'deterministic_mlp' },
            { surface: 'summary', active: true, fallback: 'deterministic_summary' },
          ],
        },
      },
    };
    const res = await app.request(
      jsonReq('/v1/ai/admin/governance/llm', 'GET', undefined, aiTeam.cookie),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: { enabled: boolean; lanes: { moderation: { simulated: boolean } } };
    };
    expect(body.status.enabled).toBe(true);
    expect(body.status.lanes.moderation.simulated).toBe(true);

    // AI-team gated like the rest of the admin surface.
    expect(
      (await app.request(jsonReq('/v1/ai/admin/governance/llm', 'GET', undefined, regular.cookie)))
        .status,
    ).toBe(403);
  });

  it('lets the AI team deprecate a model and read the blocked-invocation audit', async () => {
    const aiTeam = await seedUserWithSession(forum.identity, { admin: true });
    const dep = await app.request(
      jsonReq(
        '/v1/ai/admin/models/topic-classifier/1.0.0/deprecate',
        'POST',
        { reason: 'superseded' },
        aiTeam.cookie,
      ),
    );
    expect(dep.status).toBe(200);
    const blocked = await app.request(
      jsonReq('/v1/ai/admin/blocked', 'GET', undefined, aiTeam.cookie),
    );
    expect(blocked.status).toBe(200);
  });

  it('accepts a hallucination payload on the evaluate route (generation models need it)', async () => {
    const aiTeam = await seedUserWithSession(forum.identity, { admin: true });
    const res = await app.request(
      jsonReq(
        '/v1/ai/admin/models/evaluate',
        'POST',
        {
          model_name: 'summary-generator',
          version: '1.0.0',
          modalities: ['generation'],
          risk_level: 'high',
          hallucination: {
            statements: [
              {
                text: 'The vote passed on Tuesday.',
                cited_ids: ['c1'],
                cited_source_texts: ['The council vote passed on Tuesday.'],
              },
            ],
            source_text: 'The council vote passed on Tuesday.',
            valid_citation_ids: ['c1'],
          },
        },
        aiTeam.cookie,
      ),
    );
    // The strict schema previously rejected `hallucination` (422); it is now
    // accepted and fed to the harness, which returns a decision.
    expect(res.status).toBe(200);
    const body = (await res.json()) as { decision: { evaluations?: unknown[] } };
    expect(body.decision).toBeDefined();
  });

  it('gates the review queue to stewards', async () => {
    const regular = await seedUserWithSession(forum.identity);
    const steward = await seedUserWithSession(forum.identity, { steward: true });
    expect(
      (await app.request(jsonReq('/v1/ai/admin/review', 'GET', undefined, regular.cookie))).status,
    ).toBe(403);
    expect(
      (await app.request(jsonReq('/v1/ai/admin/review', 'GET', undefined, steward.cookie))).status,
    ).toBe(200);
  });

  it('the review queue carries EVERY report for a deduped subject', async () => {
    // A repeat report about a pending subject is deliberately deduped at the
    // queue so a steward triages one entry — but the incumbent's `context` is a
    // frozen snapshot of the FIRST report, so every later reason and correction
    // text was persisted and then unreachable (the report stores had no
    // production reader at all).  The steward saw one reason and decided on it.
    const reporterA = await seedUserWithSession(forum.identity);
    const reporterB = await seedUserWithSession(forum.identity);
    const steward = await seedUserWithSession(forum.identity, { steward: true });
    await ai.summaries.putDraft({
      summaryId: 'sum-dedup',
      threadId: 'thread-dedup',
      draft: {},
      outputId: 'out-dedup',
      qualityPassed: true,
      createdAt: new Date(ai.now()).toISOString(),
    });
    for (const [reporter, reason, correction] of [
      [reporterA, 'fake_citation', null],
      [reporterB, 'factual_error', 'The vote was on Wednesday, not Tuesday.'],
    ] as const) {
      const res = await app.request(
        jsonReq(
          '/v1/ai/summaries/sum-dedup/report',
          'POST',
          correction === null ? { reason } : { reason, correction_text: correction },
          reporter.cookie,
        ),
      );
      expect(res.status).toBe(201);
    }
    const queue = await app.request(
      jsonReq('/v1/ai/admin/review', 'GET', undefined, steward.cookie),
    );
    expect(queue.status).toBe(200);
    const body = (await queue.json()) as {
      items: {
        subject_ref?: string;
        subjectRef: string;
        report_count: number;
        reports: { reason: string }[];
      }[];
    };
    const item = body.items.find((i) => i.subjectRef === 'sum-dedup');
    // ONE queue entry — the dedup still holds…
    expect(body.items.filter((i) => i.subjectRef === 'sum-dedup')).toHaveLength(1);
    // …carrying BOTH reports.
    expect(item?.report_count).toBe(2);
    expect(item?.reports.map((r) => r.reason).sort()).toEqual(['factual_error', 'fake_citation']);
  });

  it('the attached reports are BOUNDED per item; the count is not', async () => {
    // The queue read is capped at 100 items, but each expanded to a report list
    // written by third parties — anyone may report a subject — so the response
    // size was attacker-influenceable and the 100 bounded nothing.  The count
    // must stay the TRUE total: a steward's sense of scale cannot shrink with
    // the page size.
    const steward = await seedUserWithSession(forum.identity, { steward: true });
    await ai.summaries.putDraft({
      summaryId: 'sum-flood-q',
      threadId: 'thread-flood-q',
      draft: {},
      outputId: 'out-flood-q',
      qualityPassed: true,
      createdAt: new Date(ai.now()).toISOString(),
    });
    for (let i = 0; i < 30; i += 1) {
      const reporter = await seedUserWithSession(forum.identity);
      const res = await app.request(
        jsonReq(
          '/v1/ai/summaries/sum-flood-q/report',
          'POST',
          { reason: 'fake_citation' },
          reporter.cookie,
        ),
      );
      expect(res.status).toBe(201);
    }
    const queue = await app.request(
      jsonReq('/v1/ai/admin/review', 'GET', undefined, steward.cookie),
    );
    const body = (await queue.json()) as {
      items: {
        subjectRef: string;
        report_count: number;
        reports: unknown[];
        reports_truncated: boolean;
      }[];
    };
    const item = body.items.find((i) => i.subjectRef === 'sum-flood-q');
    expect(item?.report_count).toBe(30); // the whole truth…
    expect(item?.reports).toHaveLength(20); // …in a bounded payload
    expect(item?.reports_truncated).toBe(true);
  });

  it('translates content and accepts reports for any authenticated user', async () => {
    const user = await seedUserWithSession(forum.identity);
    const res = await app.request(
      jsonReq(
        '/v1/ai/translations',
        'POST',
        {
          source_kind: 'story',
          source_ref: 'story-9',
          source_text: 'The vote passed.',
          source_lang: 'en',
          target_lang: 'es',
        },
        user.cookie,
      ),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { translation: { label: string; translation_id: string } };
    expect(body.translation.label).toBe('AI-translated');

    const report = await app.request(
      jsonReq(
        `/v1/ai/translations/${body.translation.translation_id}/report`,
        'POST',
        { reason: 'mistranslation' },
        user.cookie,
      ),
    );
    expect(report.status).toBe(201);

    // The summary must exist before it can be reported (no bogus-id pollution).
    await ai.summaries.putDraft({
      summaryId: 'sum-1',
      threadId: 'thread-1',
      draft: {},
      outputId: 'out-1',
      qualityPassed: true,
      createdAt: new Date(ai.now()).toISOString(),
    });
    const summaryReport = await app.request(
      jsonReq('/v1/ai/summaries/sum-1/report', 'POST', { reason: 'fake_citation' }, user.cookie),
    );
    expect(summaryReport.status).toBe(201);

    // Reporting a non-existent summary/translation is a 404 (not queue pollution).
    expect(
      (
        await app.request(
          jsonReq(
            '/v1/ai/summaries/ghost/report',
            'POST',
            { reason: 'fake_citation' },
            user.cookie,
          ),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await app.request(
          jsonReq(
            '/v1/ai/translations/ghost/report',
            'POST',
            { reason: 'mistranslation' },
            user.cookie,
          ),
        )
      ).status,
    ).toBe(404);
  });

  it('exposes the WS-U moderation decision summary to the AI team only', async () => {
    const regular = await seedUserWithSession(forum.identity);
    const aiTeam = await seedUserWithSession(forum.identity, { admin: true });
    const now = new Date(ai.now()).toISOString();
    // Seed a decision log: allow, warn, and flag_for_review (one wrapper-clamped).
    for (const [i, [proposed, bounded]] of (
      [
        ['allow', 'allow'],
        ['warn', 'warn'],
        ['flag_for_review', 'flag_for_review'],
        ['remove', 'flag_for_review'], // the wrapper reduced a proposed remove
      ] as const
    ).entries()) {
      await ai.moderationLog.append({
        recordId: `moddec:${i}`,
        roomId: 'room-42',
        subjectRef: `c${i}`,
        proposedAction: proposed,
        boundedAction: bounded,
        clamped: proposed !== bounded,
        outputId: `out:${i}`,
        createdAt: now,
      });
    }

    // A non-AI-team user is refused.
    expect(
      (
        await app.request(
          jsonReq('/v1/ai/admin/governance/moderation/room-42', 'GET', undefined, regular.cookie),
        )
      ).status,
    ).toBe(403);

    const res = await app.request(
      jsonReq(
        '/v1/ai/admin/governance/moderation/room-42?limit=10',
        'GET',
        undefined,
        aiTeam.cookie,
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      summary: {
        total: number;
        allowed: number;
        warned: number;
        flaggedForReview: number;
        clampedByWrapper: number;
      };
      records: Array<{ subjectRef: string }>;
    };
    expect(body.summary).toEqual({
      total: 4,
      allowed: 1,
      warned: 1,
      flaggedForReview: 2,
      clampedByWrapper: 1,
    });
    expect(body.records).toHaveLength(4);

    // An unknown room is an empty, valid summary (never a 500).
    const empty = await app.request(
      jsonReq('/v1/ai/admin/governance/moderation/nope', 'GET', undefined, aiTeam.cookie),
    );
    expect(empty.status).toBe(200);
    const emptyBody = (await empty.json()) as { summary: { total: number } };
    expect(emptyBody.summary.total).toBe(0);
  });
});
