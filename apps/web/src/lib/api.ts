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
  attentionAggregateSchema,
  attentionIngestAckSchema,
  authStatusResponseSchema,
  type ChallengeStandingResponse,
  type ContributionCreateResponse,
  type ContributionWriteCreate,
  type CreateReportRequest,
  challengeStandingResponseSchema,
  contentSavedAggregateEventSchema,
  contributionCreateResponseSchema,
  type DebateArenaResponse,
  type DebateOverrideRequest,
  type DebatePositionUpdate,
  debateArenaResponseSchema,
  type FeatureFlags,
  type FeedMode,
  type FeedResponse,
  featureFlagsResponseSchema,
  feedResponseSchema,
  type LensCreateRequest,
  type LensPublic,
  lensPublicSchema,
  type NotificationPreferences,
  notificationPreferencesSchema,
  okAckSchema,
  type PrivacyLevel,
  type PushSubscriptionJson,
  type ReportCreatedResponse,
  type RoomCreateRequest,
  type RoomDetail,
  type RoomGovernanceSettingsRequest,
  type RoomJoinResponse,
  type RoomLensSelection,
  type RoomListResponse,
  type RoomSummary,
  reportCreatedResponseSchema,
  roomDetailSchema,
  roomJoinResponseSchema,
  roomLensSelectionSchema,
  roomListResponseSchema,
  roomSummarySchema,
  type SignalLedgerResponse,
  type StoryCommentsResponse,
  type StoryCreateRequest,
  type StoryCreateResponse,
  type StoryDebatesResponse,
  type StoryDetail,
  type StoryInterpretationsResponse,
  signalLedgerResponseSchema,
  storyCommentsResponseSchema,
  storyCreateResponseSchema,
  storyDebatesResponseSchema,
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
import {
  attentionUploadsCoolingDown,
  noteAttentionRateLimited,
  noteAttentionUploadOk,
} from '../signals/attention-cooldown.js';
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

/**
 * A widen that collided with an existing public story for the same URL (WS-Q.2.4).
 *
 * The colliding story's id is a TYPED field rather than a property bolted onto a
 * plain {@link ApiClientError}: producer and consumer previously agreed only by
 * each supplying its own `as ApiClientError & { existingStoryId?: string }` cast,
 * so a rename on either side compiled cleanly and silently dropped the "open the
 * existing story" affordance. `instanceof DuplicateStoryError` narrows to a
 * NON-optional id, which is what makes the drift a compile error.
 */
export class DuplicateStoryError extends ApiClientError {
  readonly existingStoryId: string;
  constructor(message: string, existingStoryId: string) {
    super('duplicate_story', message, 409);
    this.name = 'DuplicateStoryError';
    this.existingStoryId = existingStoryId;
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

/** Reset client request state (the mutation + attention serialization chains). Test helper. */
export function resetApiClientState(): void {
  mutationQueue = Promise.resolve();
  attentionUploadChain = Promise.resolve();
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

/** The typed RPC client. All app calls go through {@link apiFetch}.  The
 *  explicit annotation keeps the (very large) inferred structural type out of
 *  the declaration emit (TS7056) without weakening any call-site typing. */
export const client: ReturnType<typeof hc<AppType>> = hc<AppType>(API_BASE, { fetch: apiFetch });

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

export async function fetchFeed(mode?: FeedMode, cursor?: string): Promise<FeedResponse> {
  const response = await client.v1.feed.$get({
    query: { ...(mode ? { mode } : {}), ...(cursor ? { cursor } : {}) },
  });
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

export async function fetchThread(threadId: string): Promise<ThreadDetail> {
  const response = await client.v1.threads[':threadId'].$get({ param: { threadId } });
  return parseResponse(response, threadDetailSchema);
}

export interface StoryCommentsQuery {
  cursor?: string;
  order?: 'newest' | 'oldest';
  filter?: 'sources' | 'corrections';
  root?: string;
  /** Nested reply layers to materialize: 1 (inline section) or 2 (dedicated page). */
  depth?: 1 | 2;
}

export async function fetchStoryComments(
  storyId: string,
  query: StoryCommentsQuery = {},
): Promise<StoryCommentsResponse> {
  const params = new URLSearchParams();
  if (query.cursor) params.set('cursor', query.cursor);
  if (query.order) params.set('order', query.order);
  if (query.filter) params.set('filter', query.filter);
  if (query.root) params.set('root', query.root);
  if (query.depth) params.set('depth', String(query.depth));
  const suffix = params.toString();
  const response = await apiFetch(
    `${API_BASE}/v1/stories/${encodeURIComponent(storyId)}/comments${suffix ? `?${suffix}` : ''}`,
  );
  return parseResponse(response, storyCommentsResponseSchema);
}

export async function fetchRooms(cursor?: string): Promise<RoomListResponse> {
  const response = await client.v1.rooms.$get({ query: cursor ? { cursor } : {} });
  return parseResponse(response, roomListResponseSchema);
}

export async function fetchRoom(roomId: string): Promise<RoomDetail> {
  const response = await client.v1.rooms[':roomId'].$get({ param: { roomId } });
  return parseResponse(response, roomDetailSchema);
}

/** WS-G.2.2 — join a room, recording the member's chosen POSTING lens.  `null`
 *  (the default) joins as "Undecided"; a lens id represents that interpretation. */
export async function joinRoom(
  roomId: string,
  lensId: string | null = null,
): Promise<RoomJoinResponse> {
  const response = await client.v1.rooms[':roomId'].join.$post({
    param: { roomId },
    json: { lens_id: lensId },
  });
  return parseResponse(response, roomJoinResponseSchema);
}

export async function leaveRoom(roomId: string): Promise<void> {
  const response = await client.v1.rooms[':roomId'].join.$delete({ param: { roomId } });
  await parseResponse(response, z.object({ left: z.boolean() }));
}

/** WS-G.2.2 — change the caller's POSTING lens for a room (the SOLE way to change
 *  it; `null` returns to "Undecided").  The server validates the lens belongs to
 *  the room and that the caller is a member. */
export async function setRoomLens(
  roomId: string,
  lensId: string | null,
): Promise<RoomLensSelection> {
  const response = await client.v1.rooms[':roomId'].lens.$put({
    param: { roomId },
    json: { lens_id: lensId },
  });
  return parseResponse(response, roomLensSelectionSchema);
}

/** WS-G.2.2 — the room's interpretation lenses (read; visible to any member). */
export async function fetchRoomLenses(roomId: string): Promise<LensPublic[]> {
  const response = await client.v1.rooms[':roomId'].lenses.$get({ param: { roomId } });
  const { items } = await parseResponse(response, z.object({ items: z.array(lensPublicSchema) }));
  return items;
}

/** WS-G.2.2 — create a room lens (steward-only; the server enforces the role). */
export async function createLens(roomId: string, request: LensCreateRequest): Promise<LensPublic> {
  const response = await client.v1.rooms[':roomId'].lenses.$post({
    param: { roomId },
    json: request,
  });
  return parseResponse(response, lensPublicSchema);
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
  request: ContributionWriteCreate,
): Promise<ContributionCreateResponse> {
  const response = await client.v1.contributions.$post({ json: request });
  return parseResponse(response, contributionCreateResponseSchema);
}

export const createComment = createContribution;

// --- WS-T debate arena --------------------------------------------------------

/** The story's ACTIVE (non-resolved) debate arenas — the discovery list surfaced
 *  on the story's conversation so anyone can find + watch a live debate. */
export async function fetchStoryDebates(storyId: string): Promise<StoryDebatesResponse> {
  const response = await apiFetch(`${API_BASE}/v1/stories/${encodeURIComponent(storyId)}/debates`);
  return parseResponse(response, storyDebatesResponseSchema);
}

export async function fetchDebate(debateId: string): Promise<DebateArenaResponse> {
  const response = await apiFetch(`${API_BASE}/v1/debates/${encodeURIComponent(debateId)}`);
  return parseResponse(response, debateArenaResponseSchema);
}

export async function postDebatePosition(
  debateId: string,
  body: DebatePositionUpdate,
): Promise<DebateArenaResponse> {
  const response = await client.v1.debates[':debateId'].position.$post({
    param: { debateId },
    json: body,
  });
  return parseResponse(response, debateArenaResponseSchema);
}

export async function overrideDebate(
  debateId: string,
  body: DebateOverrideRequest,
): Promise<DebateArenaResponse> {
  const response = await client.v1.debates[':debateId'].override.$post({
    param: { debateId },
    json: body,
  });
  return parseResponse(response, debateArenaResponseSchema);
}

/** The party-driven early closes (open window only): the challenger WITHDRAWS
 *  the correction (closes `withdrawn` — no verdict; the target's Challenged
 *  tag clears) or the incumbent CONCEDES (the challenger prevails without
 *  adjudication). */
export async function closeDebate(
  debateId: string,
  action: 'withdraw' | 'concede',
): Promise<DebateArenaResponse> {
  const target = client.v1.debates[':debateId'];
  const response =
    action === 'withdraw'
      ? await target.withdraw.$post({ param: { debateId } })
      : await target.concede.$post({ param: { debateId } });
  return parseResponse(response, debateArenaResponseSchema);
}

/** The caller's OWN challenge standing (+ an optional target probe): quota,
 *  cooldown, and per-target block reasons for the correction composer — the
 *  WS-T challenge policy, rendered BEFORE a challenge is filed. */
export async function fetchChallengeStanding(
  target?: { contributionId: string } | { storyId: string },
): Promise<ChallengeStandingResponse> {
  const params = new URLSearchParams();
  if (target !== undefined) {
    if ('contributionId' in target) params.set('target_contribution_id', target.contributionId);
    else params.set('target_story_id', target.storyId);
  }
  const query = params.size > 0 ? `?${params.toString()}` : '';
  const response = await apiFetch(`${API_BASE}/v1/challenge-standing${query}`);
  return parseResponse(response, challengeStandingResponseSchema);
}

export async function createReport(request: CreateReportRequest): Promise<ReportCreatedResponse> {
  const response = await client.v1.reports.$post({ json: request });
  return parseResponse(response, reportCreatedResponseSchema);
}

/** Parse a `Retry-After` header (delta-seconds form) with a 1 s floor. */
function retryAfterSeconds(response: Response): number {
  const raw = response.headers.get('Retry-After');
  const parsed = raw !== null ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

/** The wire cap on one attention batch (`attentionAggregateBatchSchema.max`). */
const MAX_ATTENTION_BATCH = 200;

// Attention uploads are SERIALIZED through this chain so a 429's Retry-After —
// armed by the prior upload — is observed by the next BEFORE it leaves: apiFetch's
// generic mutation queue advances when the Response returns, which is too early to
// close the gate, so the cooldown check and the POST must be atomic per batch.
let attentionUploadChain: Promise<unknown> = Promise.resolve();

/** Send ONE ≤200 batch, serialized, re-checking + arming the cooldown gate. */
async function postAttentionBatch(batch: AttentionAggregate[]): Promise<AttentionIngestAck> {
  const run = attentionUploadChain.then(async () => {
    // Re-checked INSIDE the serialized turn (not just by the caller): the prior
    // upload may have armed the window while this one waited its turn.
    if (attentionUploadsCoolingDown()) {
      throw new ApiClientError('rate_limited', 'Attention uploads are cooling down', 429);
    }
    const response = await client.v1.attention.aggregates.$post({
      json: attentionAggregateBatchSchema.parse({ aggregates: batch }),
    });
    if (response.status === 429) {
      noteAttentionRateLimited(retryAfterSeconds(response));
    } else if (response.ok) {
      noteAttentionUploadOk();
    }
    return parseResponse(response, attentionIngestAckSchema);
  });
  // Keep the chain alive regardless of this batch's outcome.
  attentionUploadChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * The single network egress for attention aggregates. Idempotent, durable HINTS
 * (§25.5), so the client honours backpressure rather than hammering: a 429 arms a
 * shared Retry-After window (`signals/attention-cooldown.ts`) that BOTH upload
 * paths consult, and uploads are serialized so the window closes before the next
 * leaves. A coalesced replay can exceed the per-batch wire cap, so the set is
 * split into ≤200 batches sent in order; a failed batch throws and the caller
 * keeps the idempotent remainder queued (the server dedupes any re-send by
 * `aggregate_id`, so a partial send is safe to retry whole).
 */
export async function uploadAttentionAggregates(
  aggregates: AttentionAggregate[],
): Promise<AttentionIngestAck> {
  const valid = z.array(attentionAggregateSchema).min(1).parse(aggregates);
  let accepted = 0;
  for (let i = 0; i < valid.length; i += MAX_ATTENTION_BATCH) {
    const ack = await postAttentionBatch(valid.slice(i, i + MAX_ATTENTION_BATCH));
    accepted += ack.accepted;
  }
  return attentionIngestAckSchema.parse({ accepted });
}

/**
 * Emit the §5.3 "Save for later" attention signal (`content.saved`) for one
 * story on behalf of the authenticated session user. Rides the SAME
 * attention-ingestion privacy pipeline (`POST /v1/events/attention`): the server
 * verifies ownership against the session, applies the user's identification
 * floor + retention preference, and DISCARDS the event entirely when
 * personalization is off (§19.2). The saved COLLECTION never leaves the browser
 * — only this one deduped, privacy-leveled signal does. Best-effort by contract:
 * the caller fires it after the local save succeeds and never blocks on it.
 *
 * `privacyLevel` is the reader's CURRENT collection level (from the signal
 * processor): stamping it here makes the server fold the save under the SAME
 * actor key as the reader's aggregates (`actorKeyOfPayload` keys on
 * `privacy_level`), so a minimum-privacy reader is not split into two actors.
 * The server still strengthens (never weakens) to the durable floor.
 */
export async function emitContentSaved(
  storyId: string,
  userId: string,
  privacyLevel: PrivacyLevel,
): Promise<void> {
  const now = Date.now();
  const event = contentSavedAggregateEventSchema.parse({
    event_id: crypto.randomUUID(),
    event_type: 'content.saved',
    timestamp: new Date(now).toISOString(),
    schema_version: '1',
    nonce: crypto.randomUUID(),
    user_id: userId,
    privacy_level: privacyLevel,
    story_id: storyId,
    privacy_classification: 'aggregated',
    retention_tier: 'attention_aggregated',
  });
  // Ride the SAME serialized cooldown gate as aggregate uploads: this hits the
  // same per-account attention endpoint, so honor an armed Retry-After window
  // and arm/clear it from the response (shared backpressure, §25.5) instead of
  // hammering the endpoint while it cools down.
  const run = attentionUploadChain.then(async () => {
    if (attentionUploadsCoolingDown()) {
      throw new ApiClientError('rate_limited', 'Attention uploads are cooling down', 429);
    }
    const response = await client.v1.events.attention.$post({ json: event });
    if (response.status === 429) noteAttentionRateLimited(retryAfterSeconds(response));
    else if (response.ok) noteAttentionUploadOk();
  });
  attentionUploadChain = run.then(
    () => undefined,
    () => undefined,
  );
  await run;
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

/**
 * Absolute src for a server-minted media read path (`media.url`/`captions_url`/
 * `poster_url`). The server builds the `/v1/uploads/:id` path AND any signed,
 * expiring query for restricted (room_only) media after its read-bar check
 * (WS-Q.5.2c); the client only prefixes the API origin. The wire value is
 * validated as a same-origin uploads path (`mediaPathSchema`), so this can never
 * point off-origin.
 */
export function mediaSrc(path: string): string {
  return `${API_BASE}${path}`;
}

/** Submit a story (link/brief/image/video/…) to a home room (WS-F/WS-Q). */
export async function createStory(request: StoryCreateRequest): Promise<StoryCreateResponse> {
  const response = await client.v1.stories.$post({ json: request });
  return parseResponse(response, storyCreateResponseSchema);
}

/**
 * Upload media bytes (image/video/captions) through the scan-gated upload path.
 * EXIF/GPS is stripped server-side before storage; video containers are sniffed.
 * Uses `XMLHttpRequest` (not `fetch`) so real byte progress is reported via
 * `onProgress` (0–1); a fresh single-use CSRF token is attached and credentials
 * ride the cookie, matching the mutation contract.
 */
export async function uploadMedia(
  file: File,
  altText?: string,
  onProgress?: (fraction: number) => void,
): Promise<UploadPublic> {
  const form = new FormData();
  form.set('file', file);
  if (altText !== undefined && altText.length > 0) form.set('alt_text', altText);
  // Serialize through the SAME single-use-CSRF mutation queue as apiFetch: the
  // nonce is one-per-session and a later token fetch clobbers the prior, so an
  // upload racing another mutation would 403 one of the two. The queue is held
  // for the WHOLE upload (the server consumes the nonce only after it finishes
  // reading the body), so a token minted meanwhile cannot overwrite this one.
  const run = mutationQueue.then(async () => {
    const token = await fetchCsrfToken();
    return new Promise<{ status: number; body: unknown }>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${API_BASE}/v1/uploads`);
      xhr.withCredentials = true;
      if (token) xhr.setRequestHeader('x-csrf-token', token);
      if (onProgress) {
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) onProgress(e.loaded / e.total);
        };
      }
      xhr.onload = () => {
        let body: unknown;
        try {
          body = JSON.parse(xhr.responseText);
        } catch {
          body = null;
        }
        resolve({ status: xhr.status, body });
      };
      xhr.onerror = () => reject(new ApiClientError('network_error', 'Upload failed'));
      xhr.send(form);
    });
  });
  // Keep the chain alive regardless of this upload's outcome.
  mutationQueue = run.then(
    () => undefined,
    () => undefined,
  );
  const raw = await run;
  if (raw.status < 200 || raw.status >= 300) {
    const parsed = apiErrorSchema.safeParse(raw.body);
    throw parsed.success
      ? new ApiClientError(parsed.data.error.code, parsed.data.error.message, raw.status)
      : new ApiClientError(`http_${raw.status}`, 'Upload failed', raw.status);
  }
  const parsed = uploadPublicSchema.safeParse(raw.body);
  if (!parsed.success) throw new ApiClientError('invalid_response', 'Malformed upload response');
  return parsed.data;
}

const visibilityChangeResponseSchema = z.object({
  visibility: z.enum(['public', 'room_only']),
  changed: z.boolean(),
});
export type VisibilityChangeResult = z.infer<typeof visibilityChangeResponseSchema>;

/**
 * Narrow (public → room_only) or widen (room_only → public) a story's
 * visibility (author-only, WS-Q.2.4). A widen that collides with an existing
 * public story for the same URL throws a {@link DuplicateStoryError} carrying
 * the existing story id — or, when the 409 body is unreadable, the plain
 * {@link ApiClientError} with the same `duplicate_story` code and no id.
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
    // A non-JSON 409 body throws SyntaxError out of `json()`; catch it here so the
    // caller always sees a normalised ApiClientError, never a raw parser error.
    const raw: unknown = await response.json().catch(() => null);
    const body = storyDuplicateResponseSchema.safeParse(raw);
    const message = 'A public story already exists for this link';
    throw body.success
      ? new DuplicateStoryError(message, body.data.existing_story_id)
      : new ApiClientError('duplicate_story', message, 409);
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
