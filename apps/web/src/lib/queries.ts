// SPDX-License-Identifier: AGPL-3.0-or-later
//
// TanStack Query hooks (WS-C.1.2). Thin, typed wrappers over the RPC client that
// apply the per-data-class cache policy and a reusable optimistic-update +
// rollback pattern for mutations. Every queryFn returns zod-validated data
// (validated inside the RPC client), so nothing unvalidated reaches the cache.
import type {
  ContributionWriteCreate,
  FeedMode,
  NotificationPreferences,
  RoomCreateRequest,
  RoomJoinModel,
  RoomPostingPolicy,
  SignalLedgerResponse,
  StoryDetail,
  UserSettings,
} from '@licio/shared';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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

// --- Reads ----------------------------------------------------------------

export function useFeedQuery(mode?: FeedMode) {
  return useQuery({
    queryKey: queryKeys.feed(mode),
    queryFn: () => api.fetchFeed(mode),
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

/** MERI independent-sources drawer data (WS-H.2.3b). */
export function useIndependentSourcesQuery(storyId: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.independentSources(storyId),
    queryFn: () => api.fetchIndependentSources(storyId),
    enabled,
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
            summary: pages[0]?.summary ?? null,
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

export function useRoomQuery(roomId: string) {
  return useQuery({
    queryKey: queryKeys.room(roomId),
    queryFn: () => api.fetchRoom(roomId),
    ...cachePolicy.room,
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

/** WS-U §16.6 — record the community's ratification of an eligible model (the
 *  member-vote step). Activates the in-room agent, so it refreshes BOTH the
 *  registry and the "governed by" agent view. */
export function useApproveModelMutation(roomId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (modelId: string) => governanceApi.approveGovernanceModel(roomId, modelId),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.governanceModels(roomId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.governedBy(roomId) });
    },
  });
}

/** WS-Q.5.3b — the room feed (gated by the WS-G content bar; `enabled` lets the
 *  caller defer the fetch until the reader has passed the tier-two bar). */
export function useRoomFeedQuery(roomId: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.roomFeed(roomId),
    queryFn: () => api.fetchRoomFeed(roomId),
    enabled,
    ...cachePolicy.feed,
  });
}

/** WS-Q.5.3a — join a room from the tier-one shell (open ⇒ active; otherwise a
 *  pending request). Refreshes the room so the membership state updates. */
export function useJoinRoomMutation(roomId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.joinRoom(roomId),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.room(roomId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.rooms() });
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
  return useMutation({
    mutationFn: (input: SaveStoryInput) =>
      input.action === 'save' ? saveStory(input.story) : unsaveStory(input.storyId),
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
