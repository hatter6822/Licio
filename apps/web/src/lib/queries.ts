// SPDX-License-Identifier: AGPL-3.0-or-later
//
// TanStack Query hooks (WS-C.1.2). Thin, typed wrappers over the RPC client that
// apply the per-data-class cache policy and a reusable optimistic-update +
// rollback pattern for mutations. Every queryFn returns zod-validated data
// (validated inside the RPC client), so nothing unvalidated reaches the cache.
import type {
  BranchId,
  FeedMode,
  NotificationPreferences,
  SignalLedgerResponse,
  StoryDetail,
  UserSettings,
} from '@licio/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  cacheSignalLedger,
  cacheThreadSnapshot,
  listSavedStories,
  readCachedSignalLedger,
  saveStory,
  unsaveStory,
} from '../offline/read-through.js';
import * as api from './api.js';
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

export function useThreadQuery(threadId: string) {
  return useQuery({
    queryKey: queryKeys.thread(threadId),
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

export function useThreadBranchQuery(threadId: string, branch: BranchId) {
  return useQuery({
    queryKey: queryKeys.threadBranch(threadId, branch),
    queryFn: () => api.fetchThreadBranch(threadId, branch),
    ...cachePolicy.thread,
  });
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
