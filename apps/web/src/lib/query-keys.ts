// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Query-key factory (WS-C.1.2). One place that mints consistent, serializable
// tuple keys used for both reads and targeted invalidation, so a typo can never
// silently split a cache entry in two.
import type { BranchId, FeedMode } from '@licio/shared';

export const queryKeys = {
  feed: (mode: FeedMode = 'balanced') => ['feed', mode] as const,
  story: (storyId: string) => ['story', storyId] as const,
  thread: (threadId: string) => ['thread', threadId] as const,
  threadBranch: (threadId: string, branch: BranchId) =>
    ['thread', threadId, 'branch', branch] as const,
  rooms: () => ['rooms'] as const,
  room: (roomId: string) => ['room', roomId] as const,
  authStatus: () => ['auth-status'] as const,
  settings: () => ['settings'] as const,
  signalLedger: () => ['signal-ledger'] as const,
  savedStories: () => ['saved-stories'] as const,
  featureFlags: () => ['feature-flags'] as const,
  notificationPreferences: () => ['notification-preferences'] as const,
  notificationBudget: () => ['notification-budget'] as const,
} as const;
