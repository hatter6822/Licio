// SPDX-License-Identifier: AGPL-3.0-or-later
//
// TanStack Query configuration (WS-C.1.2). Defaults implement the cache-policy
// table: a short feed-leaning stale time, stale-while-revalidate, and
// exponential-backoff retry for idempotent GETs only. Mutations NEVER auto-retry
// — they queue via background sync when offline (WS-C.2.3). Per-query overrides
// (longer stale for profile/thread, zero for feature flags) are applied at the
// hook layer.
import { QueryClient } from '@tanstack/react-query';
import { ApiClientError } from './api.js';

/** Retry base (1s), doubling per attempt, capped — WS-C.1.2 retry policy. */
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 30_000;
const MAX_RETRIES = 3;

/**
 * Retry idempotent GETs up to {@link MAX_RETRIES} times, but never retry a
 * client error (4xx) or a zod `invalid_response` — those will not fix themselves.
 */
function shouldRetry(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiClientError) {
    if (error.code === 'invalid_response') return false;
    if (error.status !== undefined && error.status >= 400 && error.status < 500) return false;
  }
  return failureCount < MAX_RETRIES;
}

export function createAppQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Feed-leaning default (30s). Longer-lived data overrides per query.
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        retry: shouldRetry,
        retryDelay: (attempt) => Math.min(RETRY_BASE_MS * 2 ** attempt, RETRY_MAX_MS),
        refetchOnWindowFocus: true,
        refetchOnReconnect: true,
      },
      mutations: {
        // Offline mutations queue (WS-C.2.3); they must not silently auto-retry.
        retry: false,
      },
    },
  });
}

/** Per-data-class stale/gc overrides (WS-C.1.2 cache-policy table). */
export const cachePolicy = {
  feed: { staleTime: 30_000, gcTime: 5 * 60_000 },
  thread: { staleTime: 60_000, gcTime: 10 * 60_000 },
  room: { staleTime: 60_000, gcTime: 10 * 60_000 },
  profile: { staleTime: 5 * 60_000, gcTime: 30 * 60_000 },
  signalLedger: { staleTime: 60_000, gcTime: 10 * 60_000 },
  // Feature flags are always fresh and never cached (WS-C.1.3c).
  featureFlags: { staleTime: 0, gcTime: 0 },
} as const;
