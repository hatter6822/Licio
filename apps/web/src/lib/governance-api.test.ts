// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-U governance client flows against the same mocked-fetch seam as
// privacy-api.test.ts: each function builds the right /v1/rooms/* path and
// zod-validates the response before returning.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetApiClientState } from './api.js';
import {
  castRatificationBallot,
  downloadGovernanceModel,
  fetchGovernanceModels,
  fetchGovernedBy,
  fetchRatification,
  fetchStewardSeat,
  openRatification,
  proposeGovernanceModel,
} from './governance-api.js';

const realFetch = globalThis.fetch;

// The response schemas pin uuid ids (they match the server's randomUUID output);
// mock bodies must carry real uuids, not path-param shorthands.
const UUID_ROOM = '00000000-0000-4000-8000-000000000001';
const UUID_USER = '00000000-0000-4000-8000-000000000002';
const UUID_MODEL = '00000000-0000-4000-8000-000000000003';
const UUID_PROMPT = '00000000-0000-4000-8000-000000000004';
const UUID_VOTE = '00000000-0000-4000-8000-000000000005';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

type Call = { url: string; method: string; body: unknown };
const calls: Call[] = [];

function mockRoutes(routes: Record<string, (body: unknown) => Response>): void {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/api/csrf-token')) return jsonResponse({ token: 'csrf-token' });
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ url, method, body });
    const key = `${method} ${new URL(url, 'http://localhost').pathname}`;
    const handler = routes[key];
    if (!handler) return jsonResponse({ error: { code: 'not_found', message: 'no route' } }, 404);
    return handler(body);
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  resetApiClientState();
  calls.length = 0;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('governance client flows', () => {
  it('fetches the steward seat', async () => {
    mockRoutes({
      'GET /v1/rooms/r1/steward': () =>
        jsonResponse({
          seat: {
            room_id: UUID_ROOM,
            holder_user_id: UUID_USER,
            term_start: '2026-06-19T00:00:00.000Z',
            term_end: '2027-06-19T00:00:00.000Z',
            bootstrap: true,
            current_election_id: null,
          },
        }),
    });
    const res = await fetchStewardSeat('r1');
    expect(res.seat?.holder_user_id).toBe(UUID_USER);
  });

  it('fetches the "governed by" agent view (incl. the per-role model selection)', async () => {
    mockRoutes({
      'GET /v1/rooms/r1/governance/agent': () =>
        jsonResponse({
          active: true,
          frozen: false,
          model_id: UUID_MODEL,
          model_selection: {
            moderation: { repo_id: 'Qwen/Qwen3Guard-Gen-4B', revision: 'a'.repeat(40) },
            adjudication: null,
          },
          granted: ['moderate.remove'],
          recent_actions: [],
        }),
    });
    const res = await fetchGovernedBy('r1');
    expect(res.active).toBe(true);
    expect(res.granted).toEqual(['moderate.remove']);
    expect(res.model_selection?.moderation?.repo_id).toBe('Qwen/Qwen3Guard-Gen-4B');
    expect(res.model_selection?.adjudication).toBeNull();
  });

  it('lists models and downloads one', async () => {
    mockRoutes({
      'GET /v1/rooms/r1/governance/models': () =>
        jsonResponse({
          steward_user_id: UUID_USER,
          models: [
            {
              model_id: UUID_MODEL,
              artifact_digest: 'a'.repeat(64),
              status: 'eligible',
              proposed_by_user_id: UUID_USER,
              created_at: '2026-06-19T00:00:00.000Z',
            },
          ],
        }),
      'GET /v1/rooms/r1/governance/models/m1/download': () =>
        jsonResponse({
          model_id: UUID_MODEL,
          artifact_digest: 'a'.repeat(64),
          bundle: { name: 'Civility' },
        }),
    });
    expect((await fetchGovernanceModels('r1')).models[0]?.status).toBe('eligible');
    expect((await downloadGovernanceModel('r1', 'm1')).bundle['name']).toBe('Civility');
  });

  it('proposes a model, opens a ratification vote, casts a ballot, and reads the tally', async () => {
    mockRoutes({
      'POST /v1/rooms/r1/governance/models': () =>
        jsonResponse(
          { modelId: UUID_MODEL, promptId: UUID_PROMPT, artifactDigest: 'a'.repeat(64) },
          201,
        ),
      'POST /v1/rooms/r1/governance/models/m1/ratification': () =>
        jsonResponse({ vote_id: UUID_VOTE }, 201),
      'POST /v1/rooms/r1/governance/ratifications/vote-1/ballot': () => jsonResponse({ ok: true }),
      'GET /v1/rooms/r1/governance/ratification': () =>
        jsonResponse({
          vote: {
            vote_id: UUID_VOTE,
            model_id: UUID_MODEL,
            opens_at: '2026-06-19T00:00:00.000Z',
            closes_at: '2026-06-26T00:00:00.000Z',
            min_quorum: 1,
            in_favor: 1,
            opposed: 0,
          },
        }),
    });
    const proposed = await proposeGovernanceModel('r1', { bundle: {}, prompt_text: 'x' });
    expect(proposed.modelId).toBe(UUID_MODEL);
    expect((await openRatification('r1', 'm1')).vote_id).toBe(UUID_VOTE);
    expect((await castRatificationBallot('r1', 'vote-1', 'approve')).ok).toBe(true);
    expect((await fetchRatification('r1')).vote?.in_favor).toBe(1);
  });
});
