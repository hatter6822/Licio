// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-T.5 client transport for same-origin LIVE comments.  Each `comment` SSE
// frame is a nudge that the thread gained a published comment; the hook re-fetches
// the loaded comment pages so new comments appear in REAL TIME — with no "load N
// new" button — while preserving the nested reply tree, keyset pagination, and the
// `incorrect` dispute sink for free (TanStack refetches every loaded page; the
// query's `keepPreviousData` keeps the conversation on screen during the swap).
//
// The frame is validated through the shared public contribution schema at the
// network boundary before it can drive any refetch, and a short debounce coalesces
// a burst of arrivals into a single refetch.  This mirrors `debate-stream.ts`
// (refetch-on-arrival via query invalidation); the invalidation key matches the
// create-mutation's, so it covers every sort/filter/depth variant of the query.
import { contributionPublicSchema } from '@licio/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { queryKeys } from './query-keys.js';

const API_BASE: string =
  (import.meta.env['VITE_API_URL'] as string | undefined)?.replace(/\/$/, '') ?? '';
const MAX_BACKOFF_MS = 30_000;
/** Coalesce a burst of arrivals into one refetch (a busy thread stays cheap). */
const REFETCH_DEBOUNCE_MS = 400;

function streamUrl(storyId: string): string {
  return `${API_BASE}/v1/stories/${encodeURIComponent(storyId)}/comments/stream`;
}

function streamResumeUrl(storyId: string, lastEventId: string | null): string {
  const url = streamUrl(storyId);
  if (!lastEventId) return url;
  return `${url}?since=${encodeURIComponent(lastEventId)}`;
}

function parseEventData(data: string): unknown {
  try {
    return JSON.parse(data) as unknown;
  } catch {
    return null;
  }
}

/**
 * Subscribe to a story's live comment stream.  On each valid `comment` frame it
 * invalidates the story's comment query (debounced), so the section re-fetches
 * and the new comment appears without any manual action.  Resumes from the last
 * seen event id across the hook's own backoff-reconnects so a brief drop never
 * silently loses a comment.
 */
export function useCommentStream(storyId: string | null | undefined): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!storyId || typeof EventSource === 'undefined') return;

    let closed = false;
    let source: EventSource | null = null;
    let retry = 1_000;
    let retryTimer: number | null = null;
    let refetchTimer: number | null = null;
    let lastEventId: string | null = null;

    // Trailing debounce: the first arrival schedules a refetch; further arrivals
    // in the window are folded into that single pending refetch (which re-reads
    // the whole loaded set, so nothing is missed).
    const scheduleRefetch = (): void => {
      if (refetchTimer !== null) return;
      refetchTimer = window.setTimeout(() => {
        refetchTimer = null;
        void queryClient.invalidateQueries({ queryKey: queryKeys.storyComments(storyId) });
      }, REFETCH_DEBOUNCE_MS);
    };

    const connect = (): void => {
      if (closed) return;
      source = new EventSource(streamResumeUrl(storyId, lastEventId), { withCredentials: true });
      source.addEventListener('open', () => {
        retry = 1_000;
      });
      source.addEventListener('comment', (event) => {
        const parsed = contributionPublicSchema.safeParse(parseEventData(event.data));
        if (!parsed.success) return;
        lastEventId = event.lastEventId || parsed.data.contribution_id;
        scheduleRefetch();
      });
      source.addEventListener('error', () => {
        source?.close();
        source = null;
        if (closed) return;
        const delay = retry;
        retry = Math.min(MAX_BACKOFF_MS, retry * 2);
        retryTimer = window.setTimeout(connect, delay);
      });
    };

    connect();
    return () => {
      closed = true;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      if (refetchTimer !== null) window.clearTimeout(refetchTimer);
      source?.close();
      source = null;
    };
  }, [storyId, queryClient]);
}
