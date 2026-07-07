// SPDX-License-Identifier: AGPL-3.0-or-later
//
// TanStack Query hooks (WS-C.1.2). Thin, typed wrappers over the RPC client that
// apply the per-data-class cache policy and a reusable optimistic-update +
// rollback pattern for mutations. Every queryFn returns zod-validated data
// (validated inside the RPC client), so nothing unvalidated reaches the cache.
import type {
  ContributionWriteCreate,
  DebateOverrideRequest,
  DebatePositionUpdate,
  FeedMode,
  LensCreateRequest,
  NotificationPreferences,
  RoomCreateRequest,
  RoomJoinModel,
  RoomPostingPolicy,
  SignalLedgerResponse,
  StoryDetail,
  UserSettings,
} from '@licio/shared';
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { readNotificationsUsedToday } from '../offline/notification-meter.js';
import {
  cacheSignalLedger,
  cacheStoryCommentsSnapshot,
  cacheThreadSnapshot,
  listSavedStories,
  readCachedSignalLedger,
  saveStory,
  unsaveStory,
} from '../offline/read-through.js';
import { getSignalProcessor } from '../signals/runtime.js';
import { selectCollectionUserId, useAuthStore } from '../stores/auth.js';
import * as api from './api.js';
import { fetchCredentials, fetchSecurityActivity, fetchSessions } from './auth-api.js';
import * as governanceApi from './governance-api.js';
import {
  fetchDeletionStatus,
  fetchExportStatus,
  fetchPrivacySettings,
  patchPrivacySettings,
} from './privacy-api.js';
import { cachePolicy } from './query-client.js';
import { queryKeys } from './query-keys.js';
import * as wallet from './wallet-api.js';

// --- Reads ----------------------------------------------------------------

/**
 * The ranked front-page/topic feed as an INFINITE query over the server's
 * seen-aware `nextCursor` (each page is a replayable decision linking its
 * parent, WS-I.2.5). Continuation is an EXPLICIT reader choice — the UI mounts
 * the DiminishingReturnsPrompt at the page boundary and calls `fetchNextPage`;
 * nothing loads from scrolling (§13.6 / WS-B.2.8b).
 */
export function useFeedQuery(mode?: FeedMode) {
  return useInfiniteQuery({
    queryKey: queryKeys.feed(mode),
    queryFn: ({ pageParam }) => api.fetchFeed(mode, pageParam ?? undefined),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    ...cachePolicy.feed,
  });
}

export function useStoryQuery(storyId: string) {
  return useQuery({
    queryKey: queryKeys.story(storyId),
    queryFn: () => api.fetchStory(storyId),
    ...cachePolicy.feed,
  });
}

/** SCOI "Where interpretations differ" + the Needs-Context gate (WS-H.4.3a/b). */
export function useStoryInterpretationsQuery(storyId: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.storyInterpretations(storyId),
    queryFn: () => api.fetchStoryInterpretations(storyId),
    enabled: enabled && storyId.length > 0,
    ...cachePolicy.feed,
  });
}

export function useThreadQuery(threadId: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.thread(threadId),
    enabled: enabled && threadId.length > 0,
    // Write-through: a successful fetch refreshes the offline thread summary
    // (read back by the thread page when the network is unavailable, WS-C.2.2a).
    queryFn: async () => {
      const detail = await api.fetchThread(threadId);
      await cacheThreadSnapshot(detail);
      return detail;
    },
    ...cachePolicy.thread,
  });
}

export interface StoryCommentsOptions {
  order?: 'newest' | 'oldest';
  filter?: 'sources' | 'corrections';
  /** Focus the read on one comment's replies (the dedicated page's drill-down). */
  root?: string;
  /** Nested reply layers to materialize: 1 (inline section) or 2 (dedicated page). */
  depth?: 1 | 2;
}

export function useStoryCommentsQuery(storyId: string, options: StoryCommentsOptions = {}) {
  const query = useInfiniteQuery({
    queryKey: queryKeys.storyComments(storyId, options),
    queryFn: async ({ pageParam }) => {
      const page = await api.fetchStoryComments(storyId, {
        ...options,
        ...(pageParam ? { cursor: pageParam } : {}),
      });
      if (pageParam === null) await cacheStoryCommentsSnapshot(storyId, options, page);
      return page;
    },
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.next_cursor,
    enabled: storyId.length > 0,
    // Changing the sort `order` mints a new query key; keep the previous page
    // rendered during the refetch so a Newest⇄Oldest toggle reorders in place
    // instead of blanking the conversation (which would also collapse the view
    // control and drop focus). Applies to the dedicated comment page too.
    placeholderData: keepPreviousData,
    ...cachePolicy.thread,
  });
  const pages = query.data?.pages ?? [];
  return {
    ...query,
    data:
      pages.length > 0
        ? {
            comments: pages.flatMap((page) => page.comments),
            next_cursor: pages[pages.length - 1]?.next_cursor ?? null,
            // The focused anchor (dedicated page) is stable across reply pages.
            anchor: pages[0]?.anchor ?? null,
            overview: pages[0]?.overview,
          }
        : undefined,
    loadMore: () => query.fetchNextPage(),
    hasMore: query.hasNextPage,
    isFetchingMore: query.isFetchingNextPage,
  };
}

export function useRoomsQuery() {
  return useQuery({
    queryKey: queryKeys.rooms(),
    queryFn: () => api.fetchRooms(),
    ...cachePolicy.room,
  });
}

export function useRoomQuery(roomId: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.room(roomId),
    queryFn: () => api.fetchRoom(roomId),
    ...cachePolicy.room,
    enabled,
  });
}

/** WS-U §24.6 — the in-room "governed by" transparency view (active agent +
 *  recent agent actions). `enabled` defers the fetch behind the read bar. */
export function useGovernedByQuery(roomId: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.governedBy(roomId),
    queryFn: () => governanceApi.fetchGovernedBy(roomId),
    enabled,
  });
}

/** WS-U §16.6 — the elected-room-steward seat (holder + term). */
export function useStewardSeatQuery(roomId: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.stewardSeat(roomId),
    queryFn: () => governanceApi.fetchStewardSeat(roomId),
    enabled,
  });
}

/** WS-U §16.6 — the community governance-model registry (the proposal pipeline
 *  with platform-admission status). Part of the in-room transparency surface;
 *  `enabled` defers the fetch behind the read bar. */
export function useGovernanceModelsQuery(roomId: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.governanceModels(roomId),
    queryFn: () => governanceApi.fetchGovernanceModels(roomId),
    enabled,
  });
}

/** WS-U §16.6 — the elected steward's two powers: propose a community model +
 *  its prompt. Refreshes the registry and the "governed by" agent view. */
export function useProposeModelMutation(roomId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { bundle: unknown; prompt_text: string }) =>
      governanceApi.proposeGovernanceModel(roomId, body),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.governanceModels(roomId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.governedBy(roomId) });
    },
  });
}

/** WS-U §16.6 — the room's open member ratification vote (the in-room voting
 *  surface), or null. `enabled` defers the fetch behind the read bar. */
export function useRatificationQuery(roomId: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.ratification(roomId),
    queryFn: () => governanceApi.fetchRatification(roomId),
    enabled,
  });
}

/** WS-U §16.6 — the steward opens a member ratification vote on an eligible
 *  model. Refreshes the registry and the open-vote surface. */
export function useOpenRatificationMutation(roomId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (modelId: string) => governanceApi.openRatification(roomId, modelId),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.ratification(roomId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.governanceModels(roomId) });
    },
  });
}

/** WS-U §16.6 — a member casts an approve/reject ratification ballot. Refreshes
 *  the open-vote surface (the live tally). */
export function useCastBallotMutation(roomId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { voteId: string; choice: 'approve' | 'reject' }) =>
      governanceApi.castRatificationBallot(roomId, input.voteId, input.choice),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.ratification(roomId) });
    },
  });
}

/** WS-Q.5.3b — the room feed (gated by the WS-G content bar; `enabled` lets the
 *  caller defer the fetch until the reader has passed the tier-two bar). */
export function useRoomFeedQuery(roomId: string, enabled = true) {
  return useInfiniteQuery({
    queryKey: queryKeys.roomFeed(roomId),
    queryFn: ({ pageParam }) => api.fetchRoomFeed(roomId, pageParam ?? undefined),
    enabled,
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    ...cachePolicy.feed,
  });
}

/** WS-Q.5.3a / WS-G.2.2 — join a room from the tier-one shell (open ⇒ active;
 *  otherwise a pending request), recording the member's chosen POSTING lens.
 *  The variable is optional; omit it (or pass a null `lensId`) to join as the
 *  default "Undecided". Refreshes the room so the membership + lens state update. */
export function useJoinRoomMutation(roomId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars?: { lensId?: string | null }) => api.joinRoom(roomId, vars?.lensId ?? null),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.room(roomId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.rooms() });
    },
  });
}

/** WS-G.2.2 — change the caller's POSTING lens for a room (the SOLE way to change
 *  it; `null` returns to "Undecided"). Refreshes the room so the composer's
 *  posting lens + the lens control's label update. */
export function useSetRoomLensMutation(roomId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (lensId: string | null) => api.setRoomLens(roomId, lensId),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.room(roomId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.rooms() });
    },
  });
}

/** Leave a room (drops the subscription, ending governance participation).
 *  Refreshes the room + directory so the membership affordance and any
 *  joined-filtered lists reflect the change. */
export function useLeaveRoomMutation(roomId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.leaveRoom(roomId),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.room(roomId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.rooms() });
    },
  });
}

/** WS-G.2.2 — the room's interpretation lenses (read; visible to any member).
 *  Powers the comment composer's lens picker and the conversation filter. */
export function useRoomLensesQuery(roomId: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.roomLenses(roomId),
    queryFn: () => api.fetchRoomLenses(roomId),
    enabled,
    ...cachePolicy.room,
  });
}

/** WS-G.2.2 — create a room lens (steward-only; the server enforces the role).
 *  Refreshes the lens list on success. */
export function useCreateLensMutation(roomId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (request: LensCreateRequest) => api.createLens(roomId, request),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.roomLenses(roomId) });
    },
  });
}

/** WS-Q.5.3c — create a room with the visibility/join/posting axes; refreshes
 *  the directory on success. */
export function useCreateRoomMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (request: RoomCreateRequest) => api.createRoom(request),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.rooms() });
    },
  });
}

/** WS-Q.5.3c — steward change of a room's join_model / posting_policy; refreshes
 *  the room on success. */
export function useUpdateRoomSettingsMutation(roomId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (patch: { join_model?: RoomJoinModel; posting_policy?: RoomPostingPolicy }) =>
      api.updateRoomSettings(roomId, patch),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.room(roomId) });
    },
  });
}

/** WS-Q.5.3c — steward public⇄private room-visibility cascade; refreshes the
 *  room AND its feed (content visibility may have changed). */
export function useChangeRoomVisibilityMutation(roomId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (visibility: 'public' | 'private') => api.changeRoomVisibility(roomId, visibility),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.room(roomId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.roomFeed(roomId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.rooms() });
    },
  });
}

/** WS-Q.5.4a — author narrow/widen of a story's visibility; refreshes the story
 *  on success (a 409 collision rejects with the existing public story id). */
export function useChangeStoryVisibilityMutation(storyId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (visibility: 'public' | 'room_only') =>
      api.changeStoryVisibility(storyId, visibility),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.story(storyId) });
    },
  });
}

export function useSettingsQuery() {
  return useQuery({
    queryKey: queryKeys.settings(),
    queryFn: () => api.fetchSettings(),
    ...cachePolicy.profile,
  });
}

export function useSignalLedgerQuery() {
  return useQuery({
    queryKey: queryKeys.signalLedger(),
    // Network-first with offline read-through: cache the private ledger on a
    // successful fetch; fall back to the cached snapshot when offline (WS-C.2.2a).
    queryFn: async (): Promise<SignalLedgerResponse> => {
      try {
        const response = await api.fetchSignalLedger();
        await cacheSignalLedger(response.items);
        return response;
      } catch (error) {
        const cached = await readCachedSignalLedger();
        if (cached.length > 0) return { items: cached, nextCursor: null };
        throw error;
      }
    },
    ...cachePolicy.signalLedger,
  });
}

/** Saved-for-offline stories (read straight from IndexedDB; works offline). */
export function useSavedStoriesQuery() {
  return useQuery({
    queryKey: queryKeys.savedStories(),
    queryFn: () => listSavedStories(),
    ...cachePolicy.profile,
  });
}

export function useNotificationPreferencesQuery() {
  return useQuery({
    queryKey: queryKeys.notificationPreferences(),
    queryFn: () => api.fetchNotificationPreferences(),
    ...cachePolicy.profile,
  });
}

/** Today's notification volume for the budget indicator (read locally, WS-C.2.4c). */
export function useNotificationBudgetQuery() {
  return useQuery({
    queryKey: queryKeys.notificationBudget(),
    queryFn: () => readNotificationsUsedToday(),
    ...cachePolicy.profile,
  });
}

export function useCreateCommentMutation(storyId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (request: ContributionWriteCreate) => api.createComment(request),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.storyComments(storyId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.story(storyId) });
    },
  });
}

// --- WS-T debate arena --------------------------------------------------------

/**
 * The story's ACTIVE debate arenas (the discovery list).  Light polling keeps
 * the countdowns + newly-opened arenas fresh while the reader is on the story;
 * a story with no live debate simply returns an empty list.
 */
export function useStoryDebatesQuery(storyId: string) {
  return useQuery({
    queryKey: queryKeys.storyDebates(storyId),
    enabled: storyId.length > 0,
    queryFn: () => api.fetchStoryDebates(storyId),
    refetchInterval: (query) => (query.state.data?.debates.length ? 60_000 : false),
  });
}

/**
 * The live debate arena.  Polls while the arena is still `open` (the co-visible
 * editing window) so each side sees the other's current draft as they write; a
 * judged/resolved arena is static and stops polling.
 */
export function useDebateQuery(debateId: string | null) {
  return useQuery({
    queryKey: queryKeys.debate(debateId ?? 'none'),
    enabled: debateId !== null,
    queryFn: () => api.fetchDebate(debateId as string),
    refetchInterval: (query) => (query.state.data?.debate.state === 'open' ? 5_000 : false),
  });
}

export function usePostDebatePositionMutation(debateId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: DebatePositionUpdate) => api.postDebatePosition(debateId, body),
    onSuccess: (data) => queryClient.setQueryData(queryKeys.debate(debateId), data),
  });
}

export function useOverrideDebateMutation(debateId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: DebateOverrideRequest) => api.overrideDebate(debateId, body),
    onSuccess: (data) => queryClient.setQueryData(queryKeys.debate(debateId), data),
  });
}

// --- Optimistic mutations (WS-C.1.2 pattern) ------------------------------

/**
 * Update settings with an optimistic cache write that rolls back on error and
 * reconciles on settle. This is the reusable optimistic pattern for the app.
 */
export function useUpdateSettingsMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<UserSettings>) => api.updateSettings(patch),
    onMutate: async (patch) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.settings() });
      const previous = queryClient.getQueryData<UserSettings>(queryKeys.settings());
      if (previous) {
        queryClient.setQueryData<UserSettings>(queryKeys.settings(), { ...previous, ...patch });
      }
      return { previous };
    },
    onError: (_error, _patch, context) => {
      if (context?.previous) {
        queryClient.setQueryData(queryKeys.settings(), context.previous);
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.settings() });
    },
  });
}

/** Save or unsave input: saving needs the story; unsaving needs only its id. */
export type SaveStoryInput =
  | { action: 'save'; story: StoryDetail }
  | { action: 'unsave'; storyId: string };

/**
 * Save/unsave a story for offline reading. Writes through to IndexedDB and
 * invalidates the saved-stories list so the UI reflects the change immediately.
 */
export function useToggleSavedStoryMutation() {
  const queryClient = useQueryClient();
  // The session user id iff genuinely authenticated (null otherwise) — the
  // attention pipeline never attributes a signal to a non-authenticated session.
  const collectionUserId = useAuthStore(selectCollectionUserId);
  return useMutation({
    mutationFn: (input: SaveStoryInput) =>
      input.action === 'save' ? saveStory(input.story) : unsaveStory(input.storyId),
    onSuccess: (_data, input) => {
      // §5.3 "Save for later": emit the low-weight save SIGNAL only after the
      // local save succeeded, only on SAVE (never unsave), and ONLY when
      // attention collection is actually on. The gate is the SAME live
      // `isCollecting()` flag (personalization_enabled && authenticated) every
      // other signal path checks — so an opted-out reader's save never crosses
      // the network, consumes the ingest limiter, or is visible at the request
      // boundary (WS-C.4.1d), not merely discarded server-side (§19.2). The
      // private local save is the source of truth and never depends on the
      // signal reaching the server.
      if (input.action === 'save' && collectionUserId !== null) {
        const processor = getSignalProcessor();
        if (processor.isCollecting()) {
          // Stamp the reader's CURRENT collection privacy level so a
          // minimum-privacy save folds under the same actor key as their
          // attention (never a distinct pseudonymous UUID).
          void api
            .emitContentSaved(
              input.story.story_id,
              collectionUserId,
              processor.collectionPrivacyLevel(),
            )
            .catch(() => {});
        }
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.savedStories() });
    },
  });
}

export function useUpdateNotificationPreferencesMutation() {
  const queryClient = useQueryClient();
  const key = queryKeys.notificationPreferences();
  return useMutation({
    mutationFn: (patch: Partial<NotificationPreferences>) =>
      api.updateNotificationPreferences(patch),
    onMutate: async (patch) => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<NotificationPreferences>(key);
      if (previous) {
        queryClient.setQueryData<NotificationPreferences>(key, { ...previous, ...patch });
      }
      return { previous };
    },
    onError: (_error, _patch, context) => {
      if (context?.previous) queryClient.setQueryData(key, context.previous);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: key });
    },
  });
}

// --- WS-D account security + data rights -----------------------------------

export function useAuthSessionsQuery() {
  return useQuery({
    queryKey: queryKeys.authSessions(),
    queryFn: () => fetchSessions(),
    ...cachePolicy.profile,
  });
}

export function useAuthCredentialsQuery() {
  return useQuery({
    queryKey: queryKeys.authCredentials(),
    queryFn: () => fetchCredentials(),
    ...cachePolicy.profile,
  });
}

export function useSecurityActivityQuery() {
  return useQuery({
    queryKey: queryKeys.securityActivity(),
    queryFn: () => fetchSecurityActivity(),
    ...cachePolicy.profile,
  });
}

/**
 * DSAR export-job status (WS-D.2.2): polls while the job is in flight, then
 * stops — the signed download token in the response is minted per fetch.
 */
export function useExportStatusQuery(jobId: string | null) {
  return useQuery({
    queryKey: queryKeys.exportStatus(jobId ?? 'none'),
    queryFn: () => fetchExportStatus(jobId as string),
    enabled: jobId !== null,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === 'queued' || status === 'processing' ? 2_000 : false;
    },
  });
}

export function useDeletionStatusQuery() {
  return useQuery({
    queryKey: queryKeys.deletionStatus(),
    queryFn: () => fetchDeletionStatus(),
    ...cachePolicy.profile,
  });
}

/**
 * Read the DURABLE privacy + personalization settings. Consumers that
 * patch nested MAPS (e.g. `topic_repeat_preference`) MUST read first and
 * send the merged map: the server PATCH replaces each top-level
 * personalization key wholesale (replace semantics keep deletion
 * expressible), so a blind single-entry write would wipe the rest.
 */
export function useDurablePrivacySettingsQuery(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.durablePrivacySettings(),
    queryFn: fetchPrivacySettings,
    enabled,
  });
}

/**
 * Patch the DURABLE (server-enforced) privacy settings — the §19.2
 * identification floor, retention preference, and sharing toggles behind
 * `/v1/privacy/settings`. Distinct from `useUpdateSettingsMutation` (the
 * device-local UserSettings sync): this one changes what the ingestion
 * boundary enforces. Invalidates the durable-settings read on success so
 * map-merging consumers never write over a stale snapshot twice.
 */
export function useUpdateDurablePrivacyMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: patchPrivacySettings,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.durablePrivacySettings() });
    },
  });
}

// --- WS-L wallets + governance simulation ----------------------------------

/** WS-L.2.5c — the authenticated user's linked wallets (gated by cryptoEnabled). */
export function useWalletsQuery(enabled: boolean, includeUnlinked = false) {
  return useQuery({
    queryKey: [...queryKeys.wallets(), includeUnlinked] as const,
    queryFn: () => wallet.fetchWallets(includeUnlinked),
    ...cachePolicy.profile,
    enabled,
  });
}

/** WS-L.2.5c-1 — a wallet's coarse risk state (label + safe explanation only). */
export function useWalletRiskStateQuery(walletId: string | null) {
  return useQuery({
    queryKey: queryKeys.walletRiskState(walletId ?? 'none'),
    queryFn: () => wallet.fetchWalletRiskState(walletId as string),
    ...cachePolicy.profile,
    enabled: walletId !== null,
  });
}

/** WS-L.2.5a — the SIWE link flow: caller builds+signs; this posts the result. */
export function useLinkWalletMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: wallet.linkWallet,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.wallets() });
    },
  });
}

/** WS-L.2.5b — request unlink (may return a blocked-with-obligations outcome). */
export function useUnlinkWalletMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: wallet.requestWalletUnlink,
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.wallets() });
    },
  });
}

/** WS-L.4.1a — the room governance tab bundle (simulation-aware). */
export function useGovernanceTabQuery(roomId: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.governanceTab(roomId),
    queryFn: () => wallet.fetchGovernanceTab(roomId),
    ...cachePolicy.room,
    enabled,
  });
}

/** WS-L.4.1e — the comprehension quiz for a governance room. */
export function useComprehensionQuizQuery(roomId: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.comprehensionQuiz(roomId),
    queryFn: () => wallet.fetchComprehensionQuiz(roomId),
    ...cachePolicy.room,
    enabled,
  });
}

export function useSubmitComprehensionMutation(roomId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { quiz_version: string; answers: Record<string, number> }) =>
      wallet.submitComprehensionQuiz(roomId, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.comprehensionQuiz(roomId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.governanceTab(roomId) });
    },
  });
}
