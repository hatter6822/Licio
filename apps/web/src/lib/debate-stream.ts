// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-T client transport for the live debate arena.  Each `debate` SSE frame is a
// nudge that the arena changed (a co-visible position edit, the verdict, or the
// resolution); the hook re-fetches the caller's own role-scoped view so each
// side sees the other's current draft AS THEY EDIT.  The frame is validated
// through the shared observer schema at the network boundary before it can drive
// any refetch.
import { debateArenaResponseSchema } from '@licio/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { queryKeys } from './query-keys.js';

const API_BASE: string =
  (import.meta.env['VITE_API_URL'] as string | undefined)?.replace(/\/$/, '') ?? '';
const MAX_BACKOFF_MS = 30_000;

function streamUrl(debateId: string): string {
  return `${API_BASE}/v1/debates/${encodeURIComponent(debateId)}/stream`;
}

/**
 * Subscribe to a debate's live stream while `enabled`.  On each valid frame it
 * invalidates the debate query, so the arena re-fetches the viewer's role-scoped
 * view (with their edit affordances) within moments of the other side posting.
 */
export function useDebateStream(debateId: string | null, enabled: boolean): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!debateId || !enabled || typeof EventSource === 'undefined') return;

    let closed = false;
    let source: EventSource | null = null;
    let retry = 1_000;
    let retryTimer: number | null = null;

    const connect = (): void => {
      if (closed) return;
      source = new EventSource(streamUrl(debateId), { withCredentials: true });
      source.addEventListener('open', () => {
        retry = 1_000;
      });
      source.addEventListener('debate', (event) => {
        // Validate the observer frame at the trust boundary; a malformed frame is
        // dropped (never drives a refetch).
        try {
          const parsed = debateArenaResponseSchema.safeParse({
            debate: JSON.parse((event as MessageEvent<string>).data),
          });
          if (!parsed.success || parsed.data.debate.debate_id !== debateId) return;
        } catch {
          return;
        }
        void queryClient.invalidateQueries({ queryKey: queryKeys.debate(debateId) });
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
      source?.close();
      source = null;
    };
  }, [debateId, enabled, queryClient]);
}
