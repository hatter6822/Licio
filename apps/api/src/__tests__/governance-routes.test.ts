// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-U HTTP surface: the steward seat, the community model registry (propose /
// list / member-downloadable artifact / approve), and the "governed by" agent
// view. Authentication is required; steward-only writes are service-enforced.
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { getGovernanceService, resetGovernanceService } from '../governance/services.js';
import { createGovernanceRoutes } from '../routes/governance.js';
import { freshForumServices, seedUserWithSession } from './forum-test-helpers.js';

function jsonReq(path: string, method: string, body?: unknown, cookie?: string): Request {
  const init: RequestInit = {
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  return new Request(`http://localhost${path}`, init);
}

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

const bundle = {
  bundleId: 'b',
  version: '1',
  name: 'Civility',
  moderationRules: [
    { id: 'spam', when: { kind: 'link_count_gte', value: 3 }, action: 'remove', reason: 'links' },
  ],
  promptTemplates: {},
  config: {},
  requestedCapabilities: ['moderate.remove', 'moderate.flag'],
};

describe('WS-U governance routes', () => {
  let forum: ReturnType<typeof freshForumServices>;
  let app: Hono;

  beforeEach(() => {
    forum = freshForumServices();
    resetGovernanceService();
    app = new Hono().route('/v1', createGovernanceRoutes());
  });

  it('rejects unauthenticated access', async () => {
    const res = await app.request(jsonReq('/v1/rooms/r1/steward', 'GET'));
    expect(res.status).toBe(401);
  });

  it('drives the full steward → model → approve → agent flow', async () => {
    const user = await seedUserWithSession(forum.identity);
    await getGovernanceService().bootstrapSeat('r1', user.userId);

    // Seat read.
    const seatRes = await app.request(
      jsonReq('/v1/rooms/r1/steward', 'GET', undefined, user.cookie),
    );
    expect(seatRes.status).toBe(200);
    expect((await json<{ seat: { holder_user_id: string } }>(seatRes)).seat.holder_user_id).toBe(
      user.userId,
    );

    // Steward proposes a model (eagerly evaluated to eligible).
    const propose = await app.request(
      jsonReq(
        '/v1/rooms/r1/governance/models',
        'POST',
        { bundle, prompt_text: 'Moderate r1.' },
        user.cookie,
      ),
    );
    expect(propose.status).toBe(201);
    const { modelId } = await json<{ modelId: string }>(propose);
    expect(typeof modelId).toBe('string');

    // Listed as eligible.
    const list = await app.request(
      jsonReq('/v1/rooms/r1/governance/models', 'GET', undefined, user.cookie),
    );
    const listed = (await json<{ models: { status: string }[] }>(list)).models;
    expect(listed[0]?.status).toBe('eligible');

    // Member-downloadable, integrity-pinned artifact.
    const dl = await app.request(
      jsonReq(`/v1/rooms/r1/governance/models/${modelId}/download`, 'GET', undefined, user.cookie),
    );
    expect((await json<{ bundle: { name: string } }>(dl)).bundle.name).toBe('Civility');

    // Approve ⇒ active binding with the derived capabilities.
    const approve = await app.request(
      jsonReq(
        `/v1/rooms/r1/governance/models/${modelId}/approve`,
        'POST',
        { election_id: null },
        user.cookie,
      ),
    );
    expect(approve.status).toBe(200);
    expect((await json<{ granted: string[] }>(approve)).granted).toContain('moderate.remove');

    // "Governed by" view shows the active agent.
    const agent = await app.request(
      jsonReq('/v1/rooms/r1/governance/agent', 'GET', undefined, user.cookie),
    );
    const agentBody = await json<{ active: boolean; model_id: string }>(agent);
    expect(agentBody.active).toBe(true);
    expect(agentBody.model_id).toBe(modelId);
  });

  it('forbids a non-steward from proposing', async () => {
    const steward = await seedUserWithSession(forum.identity);
    const other = await seedUserWithSession(forum.identity);
    await getGovernanceService().bootstrapSeat('r2', steward.userId);
    const res = await app.request(
      jsonReq('/v1/rooms/r2/governance/models', 'POST', { bundle, prompt_text: 'x' }, other.cookie),
    );
    expect(res.status).toBe(403);
  });

  it('returns a 404 for a download from the wrong room', async () => {
    const user = await seedUserWithSession(forum.identity);
    await getGovernanceService().bootstrapSeat('r3', user.userId);
    const propose = await app.request(
      jsonReq('/v1/rooms/r3/governance/models', 'POST', { bundle, prompt_text: 'x' }, user.cookie),
    );
    const { modelId } = await json<{ modelId: string }>(propose);
    const dl = await app.request(
      jsonReq(
        `/v1/rooms/other/governance/models/${modelId}/download`,
        'GET',
        undefined,
        user.cookie,
      ),
    );
    expect(dl.status).toBe(404);
  });
});
