// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-U governance client flows against the same mocked-fetch seam as
// privacy-api.test.ts: each function builds the right /v1/rooms/* path and
// zod-validates the response before returning.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetApiClientState } from './api.js';
import {
  approveGovernanceModel,
  downloadGovernanceModel,
  fetchGovernanceModels,
  fetchGovernedBy,
  fetchStewardSeat,
  proposeGovernanceModel,
} from './governance-api.js';

const realFetch = globalThis.fetch;

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
            room_id: 'r1',
            holder_user_id: 'u1',
            term_start: '2026-06-19T00:00:00.000Z',
            term_end: '2027-06-19T00:00:00.000Z',
            bootstrap: true,
            current_election_id: null,
          },
        }),
    });
    const res = await fetchStewardSeat('r1');
    expect(res.seat?.holder_user_id).toBe('u1');
  });

  it('fetches the "governed by" agent view', async () => {
    mockRoutes({
      'GET /v1/rooms/r1/governance/agent': () =>
        jsonResponse({
          active: true,
          frozen: false,
          model_id: 'm1',
          granted: ['moderate.remove'],
          recent_actions: [],
        }),
    });
    const res = await fetchGovernedBy('r1');
    expect(res.active).toBe(true);
    expect(res.granted).toEqual(['moderate.remove']);
  });

  it('lists models and downloads one', async () => {
    mockRoutes({
      'GET /v1/rooms/r1/governance/models': () =>
        jsonResponse({
          steward_user_id: 'u1',
          models: [
            {
              model_id: 'm1',
              artifact_digest: 'a'.repeat(64),
              status: 'eligible',
              proposed_by_user_id: 'u1',
              created_at: '2026-06-19T00:00:00.000Z',
            },
          ],
        }),
      'GET /v1/rooms/r1/governance/models/m1/download': () =>
        jsonResponse({
          model_id: 'm1',
          artifact_digest: 'a'.repeat(64),
          bundle: { name: 'Civility' },
        }),
    });
    expect((await fetchGovernanceModels('r1')).models[0]?.status).toBe('eligible');
    expect((await downloadGovernanceModel('r1', 'm1')).bundle['name']).toBe('Civility');
  });

  it('proposes and approves a model', async () => {
    mockRoutes({
      'POST /v1/rooms/r1/governance/models': () =>
        jsonResponse({ modelId: 'm1', promptId: 'p1', artifactDigest: 'a'.repeat(64) }, 201),
      'POST /v1/rooms/r1/governance/models/m1/approve': () =>
        jsonResponse({ active: true, granted: ['moderate.remove'] }),
    });
    const proposed = await proposeGovernanceModel('r1', { bundle: {}, prompt_text: 'x' });
    expect(proposed.modelId).toBe('m1');
    const approved = await approveGovernanceModel('r1', 'm1');
    expect(approved.active).toBe(true);
  });
});
