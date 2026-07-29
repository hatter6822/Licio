// SPDX-License-Identifier: AGPL-3.0-or-later
import type { UserContext } from '@licio/shared';
import { feedResponseSchema } from '@licio/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  attentionUploadsCoolingDown,
  resetAttentionCooldown,
} from '../signals/attention-cooldown.js';
import { useAuthStore } from '../stores/auth.js';
import {
  ApiClientError,
  changeStoryVisibility,
  createContribution,
  createLens,
  DuplicateStoryError,
  fetchFeed,
  fetchRoomLenses,
  joinRoom,
  parseResponse,
  resetApiClientState,
  setRoomLens,
  uploadAttentionAggregates,
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
  roles: [],
  steward_roles: [],
};

const VALID_CONTRIBUTION = {
  contribution: {
    contribution_id: '22222222-2222-4222-8222-222222222222',
    thread_id: '33333333-3333-4333-8333-333333333333',
    type: 'comment',
    body: 'A source.',
    citations: [{ url: 'https://example.org/source' }],
    metadata: {},
    target_claim_id: null,
    parent_contribution_id: null,
    author_handle: 'mara',
    author_display_name: 'Mara',
    is_author: true,
    depth: 0,
    child_count: 0,
    moderation_state: 'published',
    edited: false,
    created_at: '2026-06-09T13:00:00.000Z',
    updated_at: '2026-06-09T13:00:00.000Z',
  },
  deduplicated: false,
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
    await fetchFeed('new');
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
      type: 'comment',
      body: 'A source.',
      citations: [{ url: 'https://example.org/source' }],
      client_draft_id: 'draft-1',
    });
    const postCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.find((c) =>
      String(c[0]).includes('/v1/contributions'),
    );
    const headers = new Headers((postCall?.[1] as RequestInit | undefined)?.headers);
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
      type: 'comment' as const,
      body: 'x',
      citations: [{ url: 'https://example.org/source' }],
      client_draft_id: 'd',
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
      type: 'comment' as const,
      body: 'x',
      citations: [{ url: 'https://example.org/source' }],
      client_draft_id: 'd',
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

describe('uploadAttentionAggregates rate-limit backoff (WS-C.4.4)', () => {
  // A schema-valid §22.1 aggregate (buckets only — no raw traces).
  const AGGREGATE = {
    aggregate_id: '44444444-4444-4444-8444-444444444444',
    user_id_or_privacy_bucket: 'user-1',
    story_id: '11111111-1111-4111-8111-111111111111',
    session_bucket: '2026-06-09T13:00:00.000Z',
    active_dwell_bucket: 'medium' as const,
    source_opened: true,
    context_opened: false,
    reply_depth_bucket: 'moderate' as const,
    return_visit_count_bucket: 'few' as const,
    privacy_level: 'standard' as const,
    created_at: '2026-06-09T13:30:00.000Z',
  };

  beforeEach(() => resetAttentionCooldown());
  afterEach(() => resetAttentionCooldown());

  it('arms the cooldown from Retry-After on a 429', async () => {
    mockFetch(async (url) => {
      if (url.includes('/api/csrf-token')) return jsonResponse({ token: 't' });
      return new Response(JSON.stringify({ error: { code: 'rate_limited', message: 'wait' } }), {
        status: 429,
        headers: { 'content-type': 'application/json', 'Retry-After': '42' },
      });
    });
    await expect(uploadAttentionAggregates([AGGREGATE])).rejects.toMatchObject({ status: 429 });
    expect(attentionUploadsCoolingDown()).toBe(true);
  });

  it('short-circuits WITHOUT touching the network while cooling down', async () => {
    mockFetch(async (url) => {
      if (url.includes('/api/csrf-token')) return jsonResponse({ token: 't' });
      return new Response(JSON.stringify({ error: { code: 'rate_limited', message: 'wait' } }), {
        status: 429,
        headers: { 'content-type': 'application/json', 'Retry-After': '42' },
      });
    });
    await expect(uploadAttentionAggregates([AGGREGATE])).rejects.toMatchObject({ status: 429 });

    const fetchSpy = globalThis.fetch as ReturnType<typeof vi.fn>;
    fetchSpy.mockClear();
    // A second upload during the window never reaches fetch (no POST, no CSRF GET).
    await expect(uploadAttentionAggregates([AGGREGATE])).rejects.toMatchObject({ status: 429 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('clears the cooldown after a successful upload', async () => {
    mockFetch(async (url) => {
      if (url.includes('/api/csrf-token')) return jsonResponse({ token: 't' });
      return jsonResponse({ accepted: 1 }, 202);
    });
    await uploadAttentionAggregates([AGGREGATE]);
    expect(attentionUploadsCoolingDown()).toBe(false);
  });

  it('splits an over-cap coalesced set into ≤200-aggregate batches', async () => {
    const sizes: number[] = [];
    let posts = 0;
    mockFetch(async (url, init) => {
      if (url.includes('/api/csrf-token')) return jsonResponse({ token: 't' });
      posts += 1;
      const body = JSON.parse(String(init?.body)) as { aggregates: unknown[] };
      sizes.push(body.aggregates.length);
      return jsonResponse({ accepted: body.aggregates.length }, 202);
    });
    const many = Array.from({ length: 250 }, () => AGGREGATE);

    const ack = await uploadAttentionAggregates(many);

    expect(posts).toBe(2);
    expect(sizes).toEqual([200, 50]); // never exceeds the schema's batch cap
    expect(ack.accepted).toBe(250);
  });

  it('serializes uploads so a concurrent second backs off once the first 429s', async () => {
    let posts = 0;
    mockFetch(async (url) => {
      if (url.includes('/api/csrf-token')) return jsonResponse({ token: 't' });
      posts += 1;
      return new Response(JSON.stringify({ error: { code: 'rate_limited', message: 'wait' } }), {
        status: 429,
        headers: { 'content-type': 'application/json', 'Retry-After': '30' },
      });
    });

    const [first, second] = await Promise.allSettled([
      uploadAttentionAggregates([AGGREGATE]),
      uploadAttentionAggregates([AGGREGATE]),
    ]);

    expect(first.status).toBe('rejected');
    expect(second.status).toBe('rejected');
    // The second saw the armed cooldown inside the serialized turn and never
    // reached the network — only ONE request hit the rate-limited endpoint.
    expect(posts).toBe(1);
  });
});

describe('room lens client (WS-G.2.2)', () => {
  const ROOM_ID = '11111111-1111-4111-8111-111111111111';
  const LENS = {
    lens_id: '22222222-2222-4222-8222-222222222222',
    room_id: ROOM_ID,
    name: 'Skeptical',
    lens_type: 'skeptical' as const,
    description: null,
    created_at: '2026-06-09T13:00:00.000Z',
  };

  it('fetchRoomLenses returns the validated lens list', async () => {
    mockFetch(async (url) => {
      expect(url).toContain(`/v1/rooms/${ROOM_ID}/lenses`);
      return jsonResponse({ items: [LENS] });
    });
    const result = await fetchRoomLenses(ROOM_ID);
    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe('Skeptical');
  });

  it('createLens posts the request and returns the created lens', async () => {
    let posted: unknown;
    mockFetch(async (url, init) => {
      if (url.includes('/api/csrf-token')) return jsonResponse({ token: 't' });
      expect(url).toContain(`/v1/rooms/${ROOM_ID}/lenses`);
      posted = JSON.parse(String(init?.body));
      return jsonResponse(LENS, 201);
    });
    const created = await createLens(ROOM_ID, { name: 'Skeptical', lens_type: 'skeptical' });
    expect(created.lens_id).toBe(LENS.lens_id);
    expect(posted).toMatchObject({ name: 'Skeptical', lens_type: 'skeptical' });
  });

  const ROOM_SUMMARY = {
    room_id: ROOM_ID,
    name: 'Hydrology',
    slug: 'hydrology',
    room_type: 'global_topic' as const,
    visibility: 'public' as const,
    join_model: 'open' as const,
    posting_policy: 'all_members' as const,
    description: null,
    thread_count: 0,
    member_count: 1,
    latest_activity_at: null,
    governance_mode: 'ordinary' as const,
    joined: true,
    can_post: true,
    created_at: '2026-06-09T13:00:00.000Z',
  };

  it('joinRoom posts the chosen lens (null = Undecided by default)', async () => {
    const posted: unknown[] = [];
    mockFetch(async (url, init) => {
      if (url.includes('/api/csrf-token')) return jsonResponse({ token: 't' });
      expect(url).toContain(`/v1/rooms/${ROOM_ID}/join`);
      posted.push(JSON.parse(String(init?.body)));
      return jsonResponse({ status: 'active', room: ROOM_SUMMARY });
    });
    const joined = await joinRoom(ROOM_ID, LENS.lens_id);
    expect(joined.status).toBe('active');
    expect(posted[0]).toEqual({ lens_id: LENS.lens_id });
    // The default (no arg) joins as Undecided (null).
    await joinRoom(ROOM_ID);
    expect(posted[1]).toEqual({ lens_id: null });
  });

  it('setRoomLens puts the chosen lens and returns the echoed selection', async () => {
    let posted: unknown;
    mockFetch(async (url, init) => {
      if (url.includes('/api/csrf-token')) return jsonResponse({ token: 't' });
      expect(url).toContain(`/v1/rooms/${ROOM_ID}/lens`);
      expect(init?.method).toBe('PUT');
      posted = JSON.parse(String(init?.body));
      return jsonResponse({ lens_id: LENS.lens_id });
    });
    const result = await setRoomLens(ROOM_ID, LENS.lens_id);
    expect(result.lens_id).toBe(LENS.lens_id);
    expect(posted).toEqual({ lens_id: LENS.lens_id });
  });
});

describe('changeStoryVisibility duplicate collision (WS-Q.2.4)', () => {
  const STORY_ID = '44444444-4444-4444-8444-444444444444';
  const EXISTING_ID = '55555555-5555-4555-8555-555555555555';

  it('throws a TYPED DuplicateStoryError carrying the colliding story id', async () => {
    mockFetch(async (url) => {
      if (url.includes('/api/csrf-token')) return jsonResponse({ token: 't' });
      return jsonResponse(
        {
          error: { code: 'duplicate_story', message: 'already public' },
          existing_story_id: EXISTING_ID,
        },
        409,
      );
    });
    const error = await changeStoryVisibility(STORY_ID, 'public').catch((err: unknown) => err);
    // `instanceof` — not a cast — is what makes a rename of the field a COMPILE
    // error on both sides rather than a silently dropped "open the existing
    // story" affordance.
    expect(error).toBeInstanceOf(DuplicateStoryError);
    expect((error as DuplicateStoryError).existingStoryId).toBe(EXISTING_ID);
    expect((error as DuplicateStoryError).code).toBe('duplicate_story');
    expect((error as DuplicateStoryError).status).toBe(409);
    // Still an ApiClientError, so every generic error surface keeps working.
    expect(error).toBeInstanceOf(ApiClientError);
  });

  it('falls back to a plain ApiClientError when the 409 body is unreadable', async () => {
    mockFetch(async (url) => {
      if (url.includes('/api/csrf-token')) return jsonResponse({ token: 't' });
      return new Response('<html>gateway</html>', {
        status: 409,
        headers: { 'content-type': 'text/html' },
      });
    });
    const error = await changeStoryVisibility(STORY_ID, 'public').catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ApiClientError);
    expect(error).not.toBeInstanceOf(DuplicateStoryError);
    expect((error as ApiClientError).code).toBe('duplicate_story');
  });
});
