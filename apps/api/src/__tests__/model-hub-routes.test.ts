// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The /v1/model-hub steward READ surface (WS-U model candidacy): session-gated,
// 503 fail-closed when the hub is disabled, zod-validated responses, and the
// typed hub-error mapping (definitive refusals 422, transport 502). The
// KYC-gated candidacy WRITE is the existing governance propose route — this
// surface is read-only by construction.
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ModelHubClient } from '../ai-governance/model-hub.js';
import { ModelHubError } from '../ai-governance/model-hub.js';
import {
  createInMemoryAiGovernanceServices,
  setAiGovernanceServices,
} from '../ai-governance/services.js';
import { createInMemoryEventPipelineServices } from '../events/services.js';
import { createModelHubRoutes } from '../routes/model-hub.js';
import { freshForumServices, seedUserWithSession } from './forum-test-helpers.js';

const SHA = 'e'.repeat(40);
const METADATA = {
  repo_id: 'Qwen/Qwen3.6-27B',
  revision: SHA,
  pipeline_tag: 'image-text-to-text' as const,
  license: 'apache-2.0',
  parameter_count: 27_780_000_000,
  fetched_at: '2026-07-01T00:00:00.000Z',
};

function get(path: string, cookie?: string): Request {
  return new Request(`http://localhost${path}`, {
    method: 'GET',
    headers: cookie ? { cookie } : {},
  });
}

describe('/v1/model-hub', () => {
  let forum: ReturnType<typeof freshForumServices>;
  let app: Hono;
  let services: ReturnType<typeof createInMemoryAiGovernanceServices>;

  beforeEach(() => {
    forum = freshForumServices();
    services = createInMemoryAiGovernanceServices(createInMemoryEventPipelineServices(), {});
    setAiGovernanceServices(services);
    app = new Hono().route('/v1/model-hub', createModelHubRoutes());
  });

  function hubDouble(over: Partial<ModelHubClient> = {}): ModelHubClient {
    return {
      search: async () => [
        {
          repo_id: 'Qwen/Qwen3Guard-Gen-4B',
          pipeline_tag: 'text-generation',
          license: 'apache-2.0',
          gated: false,
        },
      ],
      resolve: async () => METADATA,
      verify: async () => METADATA,
      ...over,
    };
  }

  it('rejects unauthenticated access', async () => {
    services.modelHub = hubDouble();
    expect((await app.request(get('/v1/model-hub/search?q=qwen'))).status).toBe(401);
  });

  it('answers 503 fail-closed when the hub is disabled', async () => {
    const user = await seedUserWithSession(forum.identity);
    services.modelHub = undefined;
    const res = await app.request(get('/v1/model-hub/search?q=qwen', user.cookie));
    expect(res.status).toBe(503);
  });

  it('serves search results through the shared response schema', async () => {
    const user = await seedUserWithSession(forum.identity);
    services.modelHub = hubDouble();
    const res = await app.request(get('/v1/model-hub/search?q=qwen%20guard', user.cookie));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: Array<{ repo_id: string }> };
    expect(body.results[0]?.repo_id).toBe('Qwen/Qwen3Guard-Gen-4B');
  });

  it('resolves a repo to its pinned head revision, and verifies an explicit pin', async () => {
    const user = await seedUserWithSession(forum.identity);
    const verifyCalls: string[] = [];
    services.modelHub = hubDouble({
      verify: async (ref) => {
        verifyCalls.push(ref.revision);
        return METADATA;
      },
    });
    const head = await app.request(get('/v1/model-hub/models/Qwen/Qwen3.6-27B', user.cookie));
    expect(head.status).toBe(200);
    const headBody = (await head.json()) as { metadata: { revision: string } };
    expect(headBody.metadata.revision).toBe(SHA);
    expect(verifyCalls).toHaveLength(0); // head resolution uses resolve()
    const pinned = await app.request(
      get(`/v1/model-hub/models/Qwen/Qwen3.6-27B?revision=${SHA}`, user.cookie),
    );
    expect(pinned.status).toBe(200);
    expect(verifyCalls).toEqual([SHA]);
  });

  it('maps definitive hub refusals to 422 and transport faults to 502', async () => {
    const user = await seedUserWithSession(forum.identity);
    services.modelHub = hubDouble({
      resolve: async () => {
        throw new ModelHubError('gated', 'gated model');
      },
    });
    const gated = await app.request(get('/v1/model-hub/models/org/gated', user.cookie));
    expect(gated.status).toBe(422);
    const gatedBody = (await gated.json()) as { error: { code: string } };
    expect(gatedBody.error.code).toBe('hub_model_gated');

    services.modelHub = hubDouble({
      search: async () => {
        throw new ModelHubError('transport', 'down');
      },
    });
    expect((await app.request(get('/v1/model-hub/search?q=qwen', user.cookie))).status).toBe(502);
  });

  it('validates the query surface (short q, bad revision) with controlled 4xx', async () => {
    const user = await seedUserWithSession(forum.identity);
    services.modelHub = hubDouble();
    expect((await app.request(get('/v1/model-hub/search?q=a', user.cookie))).status).toBe(400);
    expect(
      (await app.request(get('/v1/model-hub/models/Qwen/Qwen3.6-27B?revision=main', user.cookie)))
        .status,
    ).toBe(400);
  });
});
