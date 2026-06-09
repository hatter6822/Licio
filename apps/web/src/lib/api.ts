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
  type Contribution,
  type CreateContributionRequest,
  type CreateReportRequest,
  contributionSchema,
  type FeatureFlags,
  type FeedMode,
  type FeedResponse,
  featureFlagsResponseSchema,
  feedResponseSchema,
  type NotificationPreferences,
  notificationPreferencesSchema,
  okAckSchema,
  type PushSubscriptionJson,
  type ReportAck,
  type RoomDetail,
  type RoomListResponse,
  reportAckSchema,
  roomDetailSchema,
  roomListResponseSchema,
  type SignalLedgerResponse,
  type StoryDetail,
  signalLedgerResponseSchema,
  storyDetailSchema,
  type ThreadDetail,
  threadDetailSchema,
  type UserSettings,
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
const csrfTokenResponseSchema = z.object({ token: z.string().min(1) });
let cachedCsrfToken: string | null = null;

async function ensureCsrfToken(): Promise<string | null> {
  if (cachedCsrfToken) return cachedCsrfToken;
  try {
    const response = await fetch(`${API_BASE}/api/csrf-token`, {
      method: 'GET',
      credentials: 'include',
    });
    if (!response.ok) return null;
    const parsed = csrfTokenResponseSchema.safeParse(await response.json());
    cachedCsrfToken = parsed.success ? parsed.data.token : null;
    return cachedCsrfToken;
  } catch {
    return null;
  }
}

/** Reset cached client state (CSRF token). Test/maintenance helper. */
export function resetApiClientState(): void {
  cachedCsrfToken = null;
}

/**
 * The single fetch interceptor: attaches credentials + CSRF, gates dev logging
 * to development, transitions auth to session-expired on a 401 from the API, and
 * invalidates the single-use CSRF token after each mutation.
 */
async function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const method = (init?.method ?? 'GET').toUpperCase();
  const headers = new Headers(init?.headers);

  if (STATE_CHANGING.has(method)) {
    const token = await ensureCsrfToken();
    if (token) headers.set('x-csrf-token', token);
  }

  if (IS_DEV) console.debug(`[api] → ${method} ${String(input)}`);
  const response = await fetch(input, { ...init, headers, credentials: 'include' });
  if (IS_DEV) console.debug(`[api] ← ${response.status} ${method} ${String(input)}`);

  if (STATE_CHANGING.has(method)) cachedCsrfToken = null;
  if (response.status === 401 && String(input).includes('/v1/')) {
    useAuthStore.getState().expireSession();
  }
  return response;
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

export async function fetchThread(threadId: string): Promise<ThreadDetail> {
  const response = await client.v1.threads[':threadId'].$get({ param: { threadId } });
  return parseResponse(response, threadDetailSchema);
}

export async function fetchThreadBranch(
  threadId: string,
  branch: BranchId,
): Promise<BranchContent> {
  const response = await client.v1.threads[':threadId'].branches[':branch'].$get({
    param: { threadId, branch },
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

export async function fetchSignalLedger(): Promise<SignalLedgerResponse> {
  const response = await client.v1['signal-ledger'].$get();
  return parseResponse(response, signalLedgerResponseSchema);
}

export async function fetchFeatureFlags(): Promise<FeatureFlags> {
  const response = await client.v1['feature-flags'].$get();
  return parseResponse(response, featureFlagsResponseSchema);
}

export async function createContribution(
  request: CreateContributionRequest,
): Promise<Contribution> {
  const response = await client.v1.contributions.$post({ json: request });
  return parseResponse(response, contributionSchema);
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
