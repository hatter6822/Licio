// SPDX-License-Identifier: AGPL-3.0-or-later
import type { UserContext } from '@licio/shared';
import { feedResponseSchema } from '@licio/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '../stores/auth.js';
import {
  ApiClientError,
  createContribution,
  fetchFeed,
  parseResponse,
  resetApiClientState,
} from './api.js';

const realFetch = globalThis.fetch;

type FetchHandler = (url: string, init: RequestInit | undefined) => Promise<Response>;
function mockFetch(handler: FetchHandler): void {
  globalThis.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
    handler(String(input), init),
  ) as unknown as typeof fetch;
}

const ACTIVE_USER: UserContext = {
  id: '11111111-1111-4111-8111-111111111111',
  handle: 'ada',
  display_name: 'Ada',
  account_state: 'active',
  locale: 'en',
};

const VALID_CONTRIBUTION = {
  contribution_id: '22222222-2222-4222-8222-222222222222',
  thread_id: '33333333-3333-4333-8333-333333333333',
  type: 'evidence',
  body: 'A source.',
  moderation_state: 'pending',
  created_at: '2026-06-09T13:00:00.000Z',
  local_draft_id: 'draft-1',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  resetApiClientState();
  useAuthStore.getState().logout();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe('parseResponse', () => {
  it('returns parsed data for a valid response', async () => {
    const res = jsonResponse({ items: [], nextCursor: null });
    await expect(parseResponse(res, feedResponseSchema)).resolves.toEqual({
      items: [],
      nextCursor: null,
    });
  });

  it('throws a normalized ApiClientError on a non-ok response', async () => {
    const res = jsonResponse({ error: { code: 'locked', message: 'Thread is locked' } }, 409);
    await expect(parseResponse(res, feedResponseSchema)).rejects.toMatchObject({
      code: 'locked',
      message: 'Thread is locked',
      status: 409,
    });
  });

  it('rejects a malformed but ok body as invalid_response', async () => {
    const res = jsonResponse({ unexpected: true });
    await expect(parseResponse(res, feedResponseSchema)).rejects.toMatchObject({
      code: 'invalid_response',
    });
  });

  it('falls back to a status-derived error when the error body is not JSON', async () => {
    const res = new Response('gateway down', { status: 502 });
    await expect(parseResponse(res, feedResponseSchema)).rejects.toMatchObject({
      code: 'http_502',
      status: 502,
    });
  });
});

describe('request interceptor', () => {
  it('sends credentials with every request', async () => {
    const calls: RequestInit[] = [];
    mockFetch(async (_url, init) => {
      if (init) calls.push(init);
      return jsonResponse({ items: [], nextCursor: null });
    });
    await fetchFeed('chronological');
    expect(calls[0]?.credentials).toBe('include');
  });

  it('attaches a single-use CSRF token to mutations', async () => {
    const urls: string[] = [];
    mockFetch(async (url) => {
      urls.push(url);
      if (url.includes('/api/csrf-token')) return jsonResponse({ token: 'tok-123' });
      return jsonResponse(VALID_CONTRIBUTION, 201);
    });
    await createContribution({
      thread_id: '33333333-3333-4333-8333-333333333333',
      branch: 'evidence',
      type: 'evidence',
      body: 'A source.',
      citations: [],
      local_draft_id: 'draft-1',
    });
    const postCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.find((c) =>
      String(c[0]).includes('/v1/contributions'),
    );
    const headers = new Headers((postCall?.[1] as RequestInit).headers);
    expect(urls.some((u) => u.includes('/api/csrf-token'))).toBe(true);
    expect(headers.get('x-csrf-token')).toBe('tok-123');
  });

  it('fetches a fresh token for each sequential mutation (no stale cache reuse)', async () => {
    let seq = 0;
    const tokenGets: number[] = [];
    mockFetch(async (url) => {
      if (url.includes('/api/csrf-token')) {
        seq += 1;
        tokenGets.push(seq);
        return jsonResponse({ token: `t-${seq}` });
      }
      return jsonResponse(VALID_CONTRIBUTION, 201);
    });
    const body = {
      thread_id: '33333333-3333-4333-8333-333333333333',
      branch: 'evidence' as const,
      type: 'evidence' as const,
      body: 'x',
      citations: [],
      local_draft_id: 'd',
    };
    await createContribution(body);
    await createContribution(body);
    expect(tokenGets).toHaveLength(2); // one fresh token per mutation
  });

  it('serializes concurrent mutations so each carries a DISTINCT single-use token', async () => {
    let seq = 0;
    const postTokens: (string | null)[] = [];
    mockFetch(async (url, init) => {
      if (url.includes('/api/csrf-token')) {
        seq += 1;
        return jsonResponse({ token: `tok-${seq}` });
      }
      postTokens.push(new Headers(init?.headers).get('x-csrf-token'));
      return jsonResponse(VALID_CONTRIBUTION, 201);
    });
    const body = {
      thread_id: '33333333-3333-4333-8333-333333333333',
      branch: 'evidence' as const,
      type: 'evidence' as const,
      body: 'x',
      citations: [],
      local_draft_id: 'd',
    };
    await Promise.all([createContribution(body), createContribution(body)]);
    expect(postTokens).toHaveLength(2);
    // No shared/clobbered nonce across concurrent mutations (the race this fixes).
    expect(new Set(postTokens).size).toBe(2);
  });

  it('does not fetch a CSRF token for GET requests', async () => {
    const urls: string[] = [];
    mockFetch(async (url) => {
      urls.push(url);
      return jsonResponse({ items: [], nextCursor: null });
    });
    await fetchFeed();
    expect(urls.some((u) => u.includes('/api/csrf-token'))).toBe(false);
  });

  it('transitions auth to session-expired on a 401 from the API', async () => {
    useAuthStore.getState().setAuthenticated(ACTIVE_USER);
    mockFetch(async () => jsonResponse({ error: { code: 'unauthorized', message: 'no' } }, 401));
    await expect(fetchFeed()).rejects.toBeInstanceOf(ApiClientError);
    expect(useAuthStore.getState().status).toBe('session-expired');
  });

  it('does NOT expire the session on a 401 step-up challenge (WS-D.1.3e)', async () => {
    useAuthStore.getState().setAuthenticated(ACTIVE_USER);
    mockFetch(async () =>
      jsonResponse({ status: 'step_up_required', methods: ['webauthn', 'email_otp'] }, 401),
    );
    await expect(fetchFeed()).rejects.toBeInstanceOf(ApiClientError);
    expect(useAuthStore.getState().status).toBe('authenticated');
  });
});
