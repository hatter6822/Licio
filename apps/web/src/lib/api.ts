// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Type-safe Hono RPC client (WS-C.3.1, SPEC §6.12.8). The client is typed
// against the BFF's exported `AppType`, so a request/response shape that drifts
// from the server contract is a `tsc` failure, not a runtime surprise. Every
// response is zod-validated before it can reach the TanStack Query cache
// (boundary defense, SPEC §6.12.7). Credentials ride in the HttpOnly cookie
// (`credentials: 'include'`) — the raw token is never read in JS (XSS-token-theft
// defense, §25.2) — and an anti-CSRF token is attached to state-changing requests.

import {
  type AttentionAggregate,
  type AttentionIngestAck,
  type AuthStatusResponse,
  apiErrorSchema,
  attentionAggregateBatchSchema,
  attentionIngestAckSchema,
  authStatusResponseSchema,
  type BranchContent,
  type BranchId,
  branchContentSchema,
  type ContributionCreate,
  type ContributionCreateResponse,
  type CreateReportRequest,
  contributionCreateResponseSchema,
  type FeatureFlags,
  type FeedMode,
  type FeedPreferences,
  type FeedPreferencesPatch,
  type FeedResponse,
  featureFlagsResponseSchema,
  feedPreferencesSchema,
  feedResponseSchema,
  type IndependentSourcesResponse,
  independentSourcesResponseSchema,
  type NotificationPreferences,
  notificationPreferencesSchema,
  okAckSchema,
  type PushSubscriptionJson,
  type ReportAck,
  type RoomCreateRequest,
  type RoomDetail,
  type RoomGovernanceSettingsRequest,
  type RoomJoinResponse,
  type RoomListResponse,
  type RoomSummary,
  reportAckSchema,
  roomDetailSchema,
  roomJoinResponseSchema,
  roomListResponseSchema,
  roomSummarySchema,
  type SignalLedgerResponse,
  type StoryCreateRequest,
  type StoryCreateResponse,
  type StoryDetail,
  type StoryInterpretationsResponse,
  signalLedgerResponseSchema,
  storyCreateResponseSchema,
  storyDetailSchema,
  storyDuplicateResponseSchema,
  storyInterpretationsResponseSchema,
  type ThreadDetail,
  threadDetailSchema,
  type UploadPublic,
  type UserSettings,
  uploadPublicSchema,
  userSettingsSchema,
  vapidPublicKeyResponseSchema,
} from '@licio/shared';
import type { AppType } from 'api';
import { hc } from 'hono/client';
import { z } from 'zod';
import { useAuthStore } from '../stores/auth.js';

const API_BASE: string =
  (import.meta.env['VITE_API_URL'] as string | undefined)?.replace(/\/$/, '') ?? '';
const IS_DEV = import.meta.env.DEV === true;
const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** A normalised, typed client-side error consumed by WS-B.2.5 ErrorState. */
export class ApiClientError extends Error {
  readonly code: string;
  readonly status: number | undefined;
  constructor(code: string, message: string, status?: number) {
    super(message);
    this.name = 'ApiClientError';
    this.code = code;
    this.status = status;
  }
}

// --- Anti-CSRF token (single-use; §6.12.11) -------------------------------
// The server issues ONE single-use nonce per session (a later GET overwrites the
// prior). So mutations must be SERIALIZED — each fetches its own fresh token and
// uses it immediately, one at a time — otherwise two concurrent mutations would
// share/clobber a nonce and the loser would 403. (Caching across mutations would
// reintroduce exactly that race.)
const csrfTokenResponseSchema = z.object({ token: z.string().min(1) });
let mutationQueue: Promise<unknown> = Promise.resolve();

/** Fetch a fresh single-use CSRF token, or null on any failure (fails closed). */
async function fetchCsrfToken(): Promise<string | null> {
  try {
    const response = await fetch(`${API_BASE}/api/csrf-token`, {
      method: 'GET',
      credentials: 'include',
    });
    if (!response.ok) return null;
    const parsed = csrfTokenResponseSchema.safeParse(await response.json());
    return parsed.success ? parsed.data.token : null;
  } catch {
    return null;
  }
}

/** Reset client request state (the mutation serialization chain). Test helper. */
export function resetApiClientState(): void {
  mutationQueue = Promise.resolve();
}

/** Send one request, attaching credentials (+ a CSRF token for mutations). */
async function sendRequest(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  method: string,
  token: string | null,
): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (token) headers.set('x-csrf-token', token);

  if (IS_DEV) console.debug(`[api] → ${method} ${String(input)}`);
  const response = await fetch(input, { ...init, headers, credentials: 'include' });
  if (IS_DEV) console.debug(`[api] ← ${response.status} ${method} ${String(input)}`);

  if (response.status === 401 && String(input).includes('/v1/')) {
    // A step-up challenge (WS-D.1.3e) is ALSO a 401, but the session is alive —
    // only a true authentication failure may flip the store to session-expired.
    let stepUp = false;
    try {
      const body: unknown = await response.clone().json();
      stepUp = (body as { status?: unknown } | null)?.status === 'step_up_required';
    } catch {
      // Non-JSON 401 body: treat as an authentication failure.
    }
    if (!stepUp) useAuthStore.getState().expireSession();
  }
  return response;
}

/**
 * The single fetch interceptor. GETs go straight through (parallel-safe).
 * State-changing requests are serialized through a promise chain, each acquiring
 * its own fresh single-use CSRF token immediately before sending.
 */
async function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const method = (init?.method ?? 'GET').toUpperCase();
  if (!STATE_CHANGING.has(method)) {
    return sendRequest(input, init, method, null);
  }
  const run = mutationQueue.then(async () => {
    const token = await fetchCsrfToken();
    return sendRequest(input, init, method, token);
  });
  // Keep the chain alive regardless of this request's outcome.
  mutationQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** The typed RPC client. All app calls go through {@link apiFetch}. */
export const client = hc<AppType>(API_BASE, { fetch: apiFetch });

async function normalizeError(response: Response): Promise<ApiClientError> {
  let code = `http_${response.status}`;
  let message = response.statusText || 'Request failed';
  try {
    const parsed = apiErrorSchema.safeParse(await response.json());
    if (parsed.success) {
      code = parsed.data.error.code;
      message = parsed.data.error.message;
    }
  } catch {
    // Non-JSON error body; keep the status-derived defaults.
  }
  return new ApiClientError(code, message, response.status);
}

/**
 * Validate a response through a zod schema before it can enter the cache. A
 * non-ok status becomes a typed {@link ApiClientError}; a malformed but ok body
 * is rejected as `invalid_response` (never cached as data, WS-C.1.2 edge case).
 */
export async function parseResponse<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
  if (!response.ok) throw await normalizeError(response);
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new ApiClientError('invalid_response', 'Malformed server response', response.status);
  }
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw new ApiClientError(
      'invalid_response',
      'Server response failed validation',
      response.status,
    );
  }
  return parsed.data;
}

// --- Typed endpoint functions ---------------------------------------------

export async function fetchFeed(mode?: FeedMode): Promise<FeedResponse> {
  const response = await client.v1.feed.$get({ query: mode ? { mode } : {} });
  return parseResponse(response, feedResponseSchema);
}

export async function fetchStory(storyId: string): Promise<StoryDetail> {
  const response = await client.v1.stories[':storyId'].$get({ param: { storyId } });
  return parseResponse(response, storyDetailSchema);
}

export async function fetchStoryInterpretations(
  storyId: string,
): Promise<StoryInterpretationsResponse> {
  const response = await client.v1.stories[':storyId'].interpretations.$get({
    param: { storyId },
  });
  return parseResponse(response, storyInterpretationsResponseSchema);
}

export async function fetchIndependentSources(
  storyId: string,
): Promise<IndependentSourcesResponse> {
  const response = await client.v1.stories[':storyId']['independent-sources'].$get({
    param: { storyId },
  });
  return parseResponse(response, independentSourcesResponseSchema);
}

export async function fetchThread(threadId: string): Promise<ThreadDetail> {
  const response = await client.v1.threads[':threadId'].$get({ param: { threadId } });
  return parseResponse(response, threadDetailSchema);
}

export async function fetchThreadBranch(
  threadId: string,
  branch: BranchId,
  cursor?: string,
): Promise<BranchContent> {
  const response = await client.v1.threads[':threadId'].branches[':branch'].$get({
    param: { threadId, branch },
    query: cursor ? { cursor } : {},
  });
  return parseResponse(response, branchContentSchema);
}

export async function fetchRooms(cursor?: string): Promise<RoomListResponse> {
  const response = await client.v1.rooms.$get({ query: cursor ? { cursor } : {} });
  return parseResponse(response, roomListResponseSchema);
}

export async function fetchRoom(roomId: string): Promise<RoomDetail> {
  const response = await client.v1.rooms[':roomId'].$get({ param: { roomId } });
  return parseResponse(response, roomDetailSchema);
}

export async function joinRoom(roomId: string): Promise<RoomJoinResponse> {
  const response = await client.v1.rooms[':roomId'].join.$post({ param: { roomId } });
  return parseResponse(response, roomJoinResponseSchema);
}

export async function leaveRoom(roomId: string): Promise<void> {
  const response = await client.v1.rooms[':roomId'].join.$delete({ param: { roomId } });
  await parseResponse(response, z.object({ left: z.boolean() }));
}

export async function fetchFeedPreferences(): Promise<FeedPreferences> {
  const response = await client.v1.feed.preferences.$get();
  return parseResponse(response, feedPreferencesSchema);
}

export async function updateFeedPreferences(patch: FeedPreferencesPatch): Promise<FeedPreferences> {
  const response = await client.v1.feed.preferences.$patch({ json: patch });
  return parseResponse(response, feedPreferencesSchema);
}

export async function fetchAuthStatus(): Promise<AuthStatusResponse> {
  const response = await client.v1.auth.status.$get();
  return parseResponse(response, authStatusResponseSchema);
}

export async function fetchSettings(): Promise<UserSettings> {
  const response = await client.v1.settings.$get();
  return parseResponse(response, userSettingsSchema);
}

export async function updateSettings(patch: Partial<UserSettings>): Promise<UserSettings> {
  const response = await client.v1.settings.$patch({ json: patch });
  return parseResponse(response, userSettingsSchema);
}

export async function fetchSignalLedger(cursor?: string): Promise<SignalLedgerResponse> {
  // Owner-only (WS-E.2.1d): the server returns the session user's entries.
  const response = await client.v1['signal-ledger'].$get({
    query: cursor ? { cursor } : {},
  });
  return parseResponse(response, signalLedgerResponseSchema);
}

export async function fetchFeatureFlags(): Promise<FeatureFlags> {
  const response = await client.v1['feature-flags'].$get();
  return parseResponse(response, featureFlagsResponseSchema);
}

export async function createContribution(
  request: ContributionCreate,
): Promise<ContributionCreateResponse> {
  const response = await client.v1.contributions.$post({ json: request });
  return parseResponse(response, contributionCreateResponseSchema);
}

export async function createReport(request: CreateReportRequest): Promise<ReportAck> {
  const response = await client.v1.reports.$post({ json: request });
  return parseResponse(response, reportAckSchema);
}

export async function uploadAttentionAggregates(
  aggregates: AttentionAggregate[],
): Promise<AttentionIngestAck> {
  const body = attentionAggregateBatchSchema.parse({ aggregates });
  const response = await client.v1.attention.aggregates.$post({ json: body });
  return parseResponse(response, attentionIngestAckSchema);
}

export async function fetchVapidPublicKey(): Promise<string> {
  const response = await client.v1.push['vapid-public-key'].$get();
  const { publicKey } = await parseResponse(response, vapidPublicKeyResponseSchema);
  return publicKey;
}

export async function registerPushSubscription(subscription: PushSubscriptionJson): Promise<void> {
  const response = await client.v1.push.subscriptions.$post({ json: { subscription } });
  await parseResponse(response, okAckSchema);
}

export async function removePushSubscription(endpoint: string): Promise<void> {
  const response = await client.v1.push.subscriptions.$delete({ json: { endpoint } });
  await parseResponse(response, okAckSchema);
}

export async function fetchNotificationPreferences(): Promise<NotificationPreferences> {
  const response = await client.v1.notifications.preferences.$get();
  return parseResponse(response, notificationPreferencesSchema);
}

export async function updateNotificationPreferences(
  patch: Partial<NotificationPreferences>,
): Promise<NotificationPreferences> {
  const response = await client.v1.notifications.preferences.$patch({ json: patch });
  return parseResponse(response, notificationPreferencesSchema);
}

// --- WS-Q content–room surface --------------------------------------------

/** Same-origin gated read URL for a scan-cleared media upload (image/video). */
export function mediaUrl(uploadRef: string): string {
  return `${API_BASE}/v1/uploads/${uploadRef}`;
}

/** Submit a story (link/brief/image/video/…) to a home room (WS-F/WS-Q). */
export async function createStory(request: StoryCreateRequest): Promise<StoryCreateResponse> {
  const response = await client.v1.stories.$post({ json: request });
  return parseResponse(response, storyCreateResponseSchema);
}

/**
 * Upload media bytes (image/video) through the scan-gated upload path. EXIF/GPS
 * is stripped server-side before storage; video containers are sniffed. Goes
 * through the CSRF-serialized fetch (FormData; the browser sets the multipart
 * boundary). Upload progress is reported as an indeterminate state — `fetch`
 * cannot surface byte progress.
 */
export async function uploadMedia(file: File, altText?: string): Promise<UploadPublic> {
  const form = new FormData();
  form.set('file', file);
  if (altText !== undefined && altText.length > 0) form.set('alt_text', altText);
  const response = await apiFetch(`${API_BASE}/v1/uploads`, { method: 'POST', body: form });
  return parseResponse(response, uploadPublicSchema);
}

const visibilityChangeResponseSchema = z.object({
  visibility: z.enum(['public', 'room_only']),
  changed: z.boolean(),
});
export type VisibilityChangeResult = z.infer<typeof visibilityChangeResponseSchema>;

/**
 * Narrow (public → room_only) or widen (room_only → public) a story's
 * visibility (author-only, WS-Q.2.4). A widen that collides with an existing
 * public story for the same URL throws an {@link ApiClientError} carrying the
 * existing story id (code `duplicate_story`).
 */
export async function changeStoryVisibility(
  storyId: string,
  visibility: 'public' | 'room_only',
): Promise<VisibilityChangeResult> {
  const response = await client.v1.stories[':storyId'].visibility.$patch({
    param: { storyId },
    json: { visibility },
  });
  if (response.status === 409) {
    const body = storyDuplicateResponseSchema.safeParse(await response.json());
    const existing = body.success ? body.data.existing_story_id : undefined;
    const err = new ApiClientError(
      'duplicate_story',
      'A public story already exists for this link',
      409,
    );
    if (existing !== undefined) {
      (err as ApiClientError & { existingStoryId?: string }).existingStoryId = existing;
    }
    throw err;
  }
  return parseResponse(response, visibilityChangeResponseSchema);
}

/** Room feed (WS-I room surface; gated by the WS-G content bar). */
export async function fetchRoomFeed(roomId: string, cursor?: string): Promise<FeedResponse> {
  const response = await client.v1.rooms[':roomId'].feed.$get({
    param: { roomId },
    query: cursor ? { cursor } : {},
  });
  return parseResponse(response, feedResponseSchema);
}

/** Create a room with the WS-Q visibility/join/posting axes (WS-G.2.3c). */
export async function createRoom(request: RoomCreateRequest): Promise<RoomSummary> {
  const response = await client.v1.rooms.$post({ json: request });
  return parseResponse(response, roomSummarySchema);
}

/** Steward: change join_model / posting_policy (NOT visibility) (WS-Q.3.3b). */
export async function updateRoomSettings(
  roomId: string,
  patch: RoomGovernanceSettingsRequest,
): Promise<void> {
  const response = await client.v1.rooms[':roomId'].settings.$patch({
    param: { roomId },
    json: patch,
  });
  await parseResponse(response, z.object({ ok: z.literal(true) }));
}

/** Steward: the audited public⇄private room-visibility cascade (WS-Q.3.4). */
export async function changeRoomVisibility(
  roomId: string,
  visibility: 'public' | 'private',
): Promise<{ converted: number }> {
  const response = await client.v1.rooms[':roomId'].visibility.$post({
    param: { roomId },
    json: { visibility },
  });
  const result = await parseResponse(
    response,
    z.object({ visibility: z.enum(['public', 'private']), converted: z.number().int().min(0) }),
  );
  return { converted: result.converted };
}
