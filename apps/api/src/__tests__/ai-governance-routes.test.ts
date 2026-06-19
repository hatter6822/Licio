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
    expect(body.inventory.use_cases).toHaveLength(8);
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

    const summaryReport = await app.request(
      jsonReq('/v1/ai/summaries/sum-1/report', 'POST', { reason: 'fake_citation' }, user.cookie),
    );
    expect(summaryReport.status).toBe(201);
  });
});
