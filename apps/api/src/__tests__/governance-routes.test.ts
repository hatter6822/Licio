// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-U HTTP surface: the steward seat, the community model registry (propose /
// list / member-downloadable artifact / approve), and the "governed by" agent
// view. Authentication is required; steward-only writes are service-enforced.
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { resolveGovernanceConfig } from '../governance/config.js';
import {
  createGovernanceService,
  getGovernanceService,
  resetGovernanceService,
  setGovernanceService,
} from '../governance/services.js';
import { createGovernanceRoutes } from '../routes/governance.js';
import { freshForumServices, seedUserWithSession } from './forum-test-helpers.js';

/** Seed an active room membership (the ratification/election eligibility seam). */
async function joinRoom(
  forum: ReturnType<typeof freshForumServices>,
  roomId: string,
  userId: string,
): Promise<void> {
  await forum.forum.rooms.upsertSubscription({
    roomId,
    userId,
    status: 'active',
    requestId: randomUUID(),
    lensId: null,
    notificationPreferences: {
      threads: 'mentions',
      bridge_requests: false,
      steward_announcements: true,
    },
    requestedAt: new Date().toISOString(),
    joinedAt: new Date().toISOString(),
  });
}

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
  moderationPrompt:
    'Route link-heavy, spammy, or otherwise suspicious contributions to human review; allow civil on-topic content.',
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
    const res = await app.request(
      jsonReq('/v1/rooms/00000000-0000-4000-8000-000000000001/steward', 'GET'),
    );
    expect(res.status).toBe(401);
  });

  it('rejects a malformed (non-UUID) roomId with a controlled 4xx, never a 500', async () => {
    const user = await seedUserWithSession(forum.identity);
    const res = await app.request(
      jsonReq('/v1/rooms/not-a-uuid/steward', 'GET', undefined, user.cookie),
    );
    expect(res.status).toBe(400);
  });

  it('drives the full steward → model → ratify → agent flow', async () => {
    const user = await seedUserWithSession(forum.identity);
    await getGovernanceService().bootstrapSeat('00000000-0000-4000-8000-000000000001', user.userId);

    // Seat read.
    const seatRes = await app.request(
      jsonReq(
        '/v1/rooms/00000000-0000-4000-8000-000000000001/steward',
        'GET',
        undefined,
        user.cookie,
      ),
    );
    expect(seatRes.status).toBe(200);
    expect((await json<{ seat: { holder_user_id: string } }>(seatRes)).seat.holder_user_id).toBe(
      user.userId,
    );

    // Steward proposes a model (eagerly evaluated to eligible).
    const propose = await app.request(
      jsonReq(
        '/v1/rooms/00000000-0000-4000-8000-000000000001/governance/models',
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
      jsonReq(
        '/v1/rooms/00000000-0000-4000-8000-000000000001/governance/models',
        'GET',
        undefined,
        user.cookie,
      ),
    );
    const listed = (await json<{ models: { status: string }[] }>(list)).models;
    expect(listed[0]?.status).toBe('eligible');

    // Member-downloadable, integrity-pinned artifact.
    const dl = await app.request(
      jsonReq(
        `/v1/rooms/00000000-0000-4000-8000-000000000001/governance/models/${modelId}/download`,
        'GET',
        undefined,
        user.cookie,
      ),
    );
    expect((await json<{ bundle: { name: string } }>(dl)).bundle.name).toBe('Civility');

    // The steward opens a MEMBER ratification vote (the only path to activation).
    const open = await app.request(
      jsonReq(
        `/v1/rooms/00000000-0000-4000-8000-000000000001/governance/models/${modelId}/ratification`,
        'POST',
        {},
        user.cookie,
      ),
    );
    expect(open.status).toBe(201);
    const { vote_id } = await json<{ vote_id: string }>(open);

    // The open vote surfaces with its live tally.
    const view = await app.request(
      jsonReq(
        '/v1/rooms/00000000-0000-4000-8000-000000000001/governance/ratification',
        'GET',
        undefined,
        user.cookie,
      ),
    );
    expect((await json<{ vote: { model_id: string } | null }>(view)).vote?.model_id).toBe(modelId);

    // A quorum-meeting approving vote settles to an ACTIVE agent. Casting +
    // settling go through the service (settle is scheduler-driven; no route).
    const svc = getGovernanceService();
    await svc.castRatificationBallot(
      '00000000-0000-4000-8000-000000000001',
      vote_id,
      user.userId,
      'approve',
      true,
    );
    const settled = await svc.settleRatification(vote_id);
    expect(settled.ok && settled.value.activated).toBe(true);

    // "Governed by" view shows the active agent.
    const agent = await app.request(
      jsonReq(
        '/v1/rooms/00000000-0000-4000-8000-000000000001/governance/agent',
        'GET',
        undefined,
        user.cookie,
      ),
    );
    const agentBody = await json<{ active: boolean; model_id: string }>(agent);
    expect(agentBody.active).toBe(true);
    expect(agentBody.model_id).toBe(modelId);
  });

  it('opens a ratification vote (steward only) and gates ballots to room members', async () => {
    const steward = await seedUserWithSession(forum.identity);
    const other = await seedUserWithSession(forum.identity);
    await getGovernanceService().bootstrapSeat(
      '00000000-0000-4000-8000-000000000002',
      steward.userId,
    );
    const propose = await app.request(
      jsonReq(
        '/v1/rooms/00000000-0000-4000-8000-000000000002/governance/models',
        'POST',
        { bundle, prompt_text: 'x' },
        steward.cookie,
      ),
    );
    const { modelId } = await json<{ modelId: string }>(propose);

    // A non-steward cannot open the vote.
    const forbiddenOpen = await app.request(
      jsonReq(
        `/v1/rooms/00000000-0000-4000-8000-000000000002/governance/models/${modelId}/ratification`,
        'POST',
        {},
        other.cookie,
      ),
    );
    expect(forbiddenOpen.status).toBe(403);

    // The steward opens it.
    const open = await app.request(
      jsonReq(
        `/v1/rooms/00000000-0000-4000-8000-000000000002/governance/models/${modelId}/ratification`,
        'POST',
        {},
        steward.cookie,
      ),
    );
    expect(open.status).toBe(201);
    const { vote_id } = await json<{ vote_id: string }>(open);

    // A non-member's ballot is rejected (membership-gated).
    const nonMember = await app.request(
      jsonReq(
        `/v1/rooms/00000000-0000-4000-8000-000000000002/governance/ratifications/${vote_id}/ballot`,
        'POST',
        { choice: 'approve' },
        other.cookie,
      ),
    );
    expect(nonMember.status).toBe(403);

    // A room member (here, a community steward of the room) may vote.
    await forum.forum.rooms.addSteward({
      roomId: '00000000-0000-4000-8000-000000000002',
      userId: other.userId,
      role: 'community_steward',
      assignedAt: new Date().toISOString(),
    });
    const ok = await app.request(
      jsonReq(
        `/v1/rooms/00000000-0000-4000-8000-000000000002/governance/ratifications/${vote_id}/ballot`,
        'POST',
        { choice: 'approve' },
        other.cookie,
      ),
    );
    expect(ok.status).toBe(200);
  });

  it('steward-election vote: gates to members and validates the candidate is a member', async () => {
    const steward = await seedUserWithSession(forum.identity);
    const member = await seedUserWithSession(forum.identity);
    const candidate = await seedUserWithSession(forum.identity);
    const outsider = await seedUserWithSession(forum.identity);

    // A controllable clock so a real election can be scheduled (term-elapsed).
    let t = Date.parse('2026-06-19T00:00:00.000Z');
    resetGovernanceService();
    setGovernanceService(
      createGovernanceService({
        config: resolveGovernanceConfig({ electionTermSeconds: 100, electionWindowSeconds: 50 }),
        now: () => new Date(t),
      }),
    );
    const svc = getGovernanceService();
    await svc.bootstrapSeat('00000000-0000-4000-8000-000000000008', steward.userId);
    t += 101_000; // the term has elapsed ⇒ an election can open
    const sched = await svc.scheduleElection('00000000-0000-4000-8000-000000000008');
    const electionId = sched.ok ? sched.value : '';
    expect(electionId).not.toBe('');

    // `member` and `candidate` are active room members; `outsider` is not.
    await joinRoom(forum, '00000000-0000-4000-8000-000000000008', member.userId);
    await joinRoom(forum, '00000000-0000-4000-8000-000000000008', candidate.userId);

    const vote = (cookie: string, candidateUserId: string) =>
      app.request(
        jsonReq(
          `/v1/rooms/00000000-0000-4000-8000-000000000008/elections/${electionId}/vote`,
          'POST',
          { candidate_user_id: candidateUserId },
          cookie,
        ),
      );

    // A non-member voter is rejected (403 not_member).
    expect((await vote(outsider.cookie, candidate.userId)).status).toBe(403);
    // A member voting for a NON-member candidate is rejected (422 invalid_candidate).
    expect((await vote(member.cookie, outsider.userId)).status).toBe(422);
    // A member voting for a member candidate succeeds.
    expect((await vote(member.cookie, candidate.userId)).status).toBe(200);
    // The same voter cannot vote twice (service idempotency surfaces as 409).
    expect((await vote(member.cookie, candidate.userId)).status).toBe(409);
  });

  it('rate-limits governance writes with an identity-free cost ceiling', async () => {
    // The steward-write limiter is 120/min (shared across propose/open/law-pack)
    // and runs BEFORE auth, so an unauthenticated flood is shed with 429 once the
    // per-endpoint budget is exhausted (SPEC §19.1 load-shedding, not fairness).
    let sawRateLimited = false;
    for (let i = 0; i < 130; i += 1) {
      const res = await app.request(
        jsonReq('/v1/rooms/00000000-0000-4000-8000-000000000007/governance/law-packs', 'POST', {
          law_pack: {},
        }),
      );
      if (res.status === 429) {
        sawRateLimited = true;
        break;
      }
      expect(res.status).toBe(401); // pre-budget: unauth requests pass the limiter
    }
    expect(sawRateLimited).toBe(true);
  });

  it('forbids a non-steward from proposing', async () => {
    const steward = await seedUserWithSession(forum.identity);
    const other = await seedUserWithSession(forum.identity);
    await getGovernanceService().bootstrapSeat(
      '00000000-0000-4000-8000-000000000003',
      steward.userId,
    );
    const res = await app.request(
      jsonReq(
        '/v1/rooms/00000000-0000-4000-8000-000000000003/governance/models',
        'POST',
        { bundle, prompt_text: 'x' },
        other.cookie,
      ),
    );
    expect(res.status).toBe(403);
  });

  it('lets a platform steward freeze + restore a room agent; non-stewards are forbidden', async () => {
    const steward = await seedUserWithSession(forum.identity);
    const admin = await seedUserWithSession(forum.identity, { admin: true });
    const plain = await seedUserWithSession(forum.identity);
    await getGovernanceService().bootstrapSeat(
      '00000000-0000-4000-8000-000000000004',
      steward.userId,
    );
    // Propose + (eager-eval) eligible via the routes; activate via the service's
    // internal primitive (the production path is a member vote, exercised above).
    const propose = await app.request(
      jsonReq(
        '/v1/rooms/00000000-0000-4000-8000-000000000004/governance/models',
        'POST',
        { bundle, prompt_text: 'x' },
        steward.cookie,
      ),
    );
    const { modelId } = await json<{ modelId: string }>(propose);
    await getGovernanceService().approveModel(
      '00000000-0000-4000-8000-000000000004',
      modelId,
      null,
      null,
    );

    // A non-steward (no MFA / no role) cannot freeze the floor control.
    const forbidden = await app.request(
      jsonReq(
        '/v1/rooms/00000000-0000-4000-8000-000000000004/governance/agent/freeze',
        'POST',
        {},
        plain.cookie,
      ),
    );
    expect(forbidden.status).toBe(403);

    // A platform steward freezes ⇒ the agent view reports a floor-paused agent.
    const freeze = await app.request(
      jsonReq(
        '/v1/rooms/00000000-0000-4000-8000-000000000004/governance/agent/freeze',
        'POST',
        {},
        admin.cookie,
      ),
    );
    expect(freeze.status).toBe(200);
    const frozen = await json<{ active: boolean; frozen: boolean }>(
      await app.request(
        jsonReq(
          '/v1/rooms/00000000-0000-4000-8000-000000000004/governance/agent',
          'GET',
          undefined,
          admin.cookie,
        ),
      ),
    );
    expect(frozen.active).toBe(false);
    expect(frozen.frozen).toBe(true);

    // The floor restores it ⇒ active again.
    const unfreeze = await app.request(
      jsonReq(
        '/v1/rooms/00000000-0000-4000-8000-000000000004/governance/agent/unfreeze',
        'POST',
        {},
        admin.cookie,
      ),
    );
    expect(unfreeze.status).toBe(200);
    const active = await json<{ active: boolean; frozen: boolean }>(
      await app.request(
        jsonReq(
          '/v1/rooms/00000000-0000-4000-8000-000000000004/governance/agent',
          'GET',
          undefined,
          admin.cookie,
        ),
      ),
    );
    expect(active.active).toBe(true);
    expect(active.frozen).toBe(false);
  });

  it('returns 404 when freezing a room with no agent binding', async () => {
    const admin = await seedUserWithSession(forum.identity, { admin: true });
    const res = await app.request(
      jsonReq(
        '/v1/rooms/00000000-0000-4000-8000-000000000011/governance/agent/freeze',
        'POST',
        {},
        admin.cookie,
      ),
    );
    expect(res.status).toBe(404);
  });

  it('lets the steward propose a law-pack and bind it at approve; non-stewards forbidden', async () => {
    const steward = await seedUserWithSession(forum.identity);
    const other = await seedUserWithSession(forum.identity);
    await getGovernanceService().bootstrapSeat(
      '00000000-0000-4000-8000-000000000005',
      steward.userId,
    );
    const lawPack = {
      lawPackId: 'x',
      version: '1',
      allowedProposalTypes: ['model_prompt_approval'],
      permittedCapabilities: ['moderate.flag'], // bounds the agent below the model request
      treasury: {
        caps: [],
        minIntervalSeconds: 0,
        timelockSeconds: 0,
        materialThreshold: 0,
        requireCoiFor: [],
        investment: null,
      },
      election: {
        weightModel: 'one_civic_account_one_vote',
        perAccountCap: 1,
        minQuorum: 1,
        minTurnout: 0,
        termSeconds: 1,
      },
    };
    // A non-steward cannot propose the room's bounds.
    const forbidden = await app.request(
      jsonReq(
        '/v1/rooms/00000000-0000-4000-8000-000000000005/governance/law-packs',
        'POST',
        { law_pack: lawPack },
        other.cookie,
      ),
    );
    expect(forbidden.status).toBe(403);

    // The steward proposes the law-pack...
    const lp = await app.request(
      jsonReq(
        '/v1/rooms/00000000-0000-4000-8000-000000000005/governance/law-packs',
        'POST',
        { law_pack: lawPack },
        steward.cookie,
      ),
    );
    expect(lp.status).toBe(201);
    const { lawPackId } = await json<{ lawPackId: string }>(lp);

    // ...then a model bound to it has its capabilities intersected with the
    // law-pack (activation primitive; the routed path is a member vote). The
    // model requests remove + flag; the law-pack permits only flag.
    const propose = await app.request(
      jsonReq(
        '/v1/rooms/00000000-0000-4000-8000-000000000005/governance/models',
        'POST',
        { bundle, prompt_text: 'x' },
        steward.cookie,
      ),
    );
    const { modelId } = await json<{ modelId: string }>(propose);
    const activated = await getGovernanceService().approveModel(
      '00000000-0000-4000-8000-000000000005',
      modelId,
      null,
      lawPackId,
    );
    if (!activated.ok) throw new Error('activation failed');
    expect(activated.value.descriptor.granted).toContain('moderate.flag');
    expect(activated.value.descriptor.granted).not.toContain('moderate.remove');
  });

  it('lets the steward ask the agent to summarise a proposal (lawmaking.summarize)', async () => {
    const steward = await seedUserWithSession(forum.identity);
    const other = await seedUserWithSession(forum.identity);
    const svc = getGovernanceService();
    await svc.bootstrapSeat('00000000-0000-4000-8000-000000000006', steward.userId);
    // A model that requests the lawmaking.summarize capability (default law-pack
    // permits it), activated via the internal primitive.
    const lawBundle = {
      ...bundle,
      requestedCapabilities: ['moderate.flag', 'lawmaking.summarize'],
    };
    const propose = await app.request(
      jsonReq(
        '/v1/rooms/00000000-0000-4000-8000-000000000006/governance/models',
        'POST',
        { bundle: lawBundle, prompt_text: 'x' },
        steward.cookie,
      ),
    );
    const { modelId } = await json<{ modelId: string }>(propose);
    await svc.approveModel('00000000-0000-4000-8000-000000000006', modelId, null, null);

    const proposal = { proposalId: 'p1', title: 'Adopt a digest', body: 'An opt-in digest.' };
    // A non-steward cannot trigger facilitation.
    const forbidden = await app.request(
      jsonReq(
        '/v1/rooms/00000000-0000-4000-8000-000000000006/governance/lawmaking/summarize',
        'POST',
        { proposal },
        other.cookie,
      ),
    );
    expect(forbidden.status).toBe(403);

    // The steward gets a neutral, deterministic summary.
    const res = await app.request(
      jsonReq(
        '/v1/rooms/00000000-0000-4000-8000-000000000006/governance/lawmaking/summarize',
        'POST',
        { proposal },
        steward.cookie,
      ),
    );
    expect(res.status).toBe(200);
    const body2 = await json<{ summary: { proposal_id?: string; summary: string } }>(res);
    expect(body2.summary.summary).toContain('Adopt a digest');
  });

  it('enforces the room content bar on governance reads for a private room', async () => {
    const steward = await seedUserWithSession(forum.identity);
    const member = await seedUserWithSession(forum.identity);
    const outsider = await seedUserWithSession(forum.identity);
    const roomId = randomUUID();
    // A PRIVATE forum room with a governance seat + a proposed model.
    await forum.forum.rooms.insert({
      roomId,
      name: `Room ${roomId.slice(0, 8)}`,
      slug: `room-${roomId.slice(0, 8)}`,
      description: null,
      roomType: 'global_topic',
      visibility: 'private',
      joinModel: 'request_approval',
      postingPolicy: 'all_members',
      createdBy: steward.userId,
      governanceMode: 'ordinary',
      charterSummary: null,
      typeMetadata: {},
      latestActivityAt: null,
    });
    await getGovernanceService().bootstrapSeat(roomId, steward.userId);
    const propose = await app.request(
      jsonReq(
        `/v1/rooms/${roomId}/governance/models`,
        'POST',
        { bundle, prompt_text: 'x' },
        steward.cookie,
      ),
    );
    const { modelId } = await json<{ modelId: string }>(propose);
    await joinRoom(forum, roomId, member.userId);

    const models = (cookie: string) =>
      app.request(jsonReq(`/v1/rooms/${roomId}/governance/models`, 'GET', undefined, cookie));
    const download = (cookie: string) =>
      app.request(
        jsonReq(
          `/v1/rooms/${roomId}/governance/models/${modelId}/download`,
          'GET',
          undefined,
          cookie,
        ),
      );

    // An outsider (authenticated non-member) cannot enumerate or download.
    expect((await models(outsider.cookie)).status).toBe(404);
    expect((await download(outsider.cookie)).status).toBe(404);
    expect(
      (
        await app.request(
          jsonReq(`/v1/rooms/${roomId}/governance/agent`, 'GET', undefined, outsider.cookie),
        )
      ).status,
    ).toBe(404);
    // The elected steward and an active member can.
    expect((await models(steward.cookie)).status).toBe(200);
    expect((await models(member.cookie)).status).toBe(200);
    expect((await download(member.cookie)).status).toBe(200);
  });

  it('returns a 404 for a download from the wrong room', async () => {
    const user = await seedUserWithSession(forum.identity);
    await getGovernanceService().bootstrapSeat('00000000-0000-4000-8000-000000000009', user.userId);
    const propose = await app.request(
      jsonReq(
        '/v1/rooms/00000000-0000-4000-8000-000000000009/governance/models',
        'POST',
        { bundle, prompt_text: 'x' },
        user.cookie,
      ),
    );
    const { modelId } = await json<{ modelId: string }>(propose);
    const dl = await app.request(
      jsonReq(
        `/v1/rooms/00000000-0000-4000-8000-000000000010/governance/models/${modelId}/download`,
        'GET',
        undefined,
        user.cookie,
      ),
    );
    expect(dl.status).toBe(404);
  });
});
