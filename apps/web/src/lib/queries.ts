// SPDX-License-Identifier: AGPL-3.0-or-later
//
// TanStack Query hooks (WS-C.1.2). Thin, typed wrappers over the RPC client that
// apply the per-data-class cache policy and a reusable optimistic-update +
// rollback pattern for mutations. Every queryFn returns zod-validated data
// (validated inside the RPC client), so nothing unvalidated reaches the cache.
import type { BranchId, FeedMode, NotificationPreferences, UserSettings } from '@licio/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
    queryFn: () => api.fetchThread(threadId),
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
    queryFn: () => api.fetchSignalLedger(),
    ...cachePolicy.signalLedger,
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
