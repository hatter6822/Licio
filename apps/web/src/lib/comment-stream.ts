// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-T.5 client transport for same-origin live comments.  The transport treats
// SSE frames as an untrusted network boundary: every `comment` event is parsed
// through the shared public contribution schema before it can enter UI state.
import { type ContributionPublic, contributionPublicSchema } from '@licio/shared';
import { useCallback, useEffect, useRef, useState } from 'react';

const API_BASE: string =
  (import.meta.env['VITE_API_URL'] as string | undefined)?.replace(/\/$/, '') ?? '';
const MAX_BACKOFF_MS = 30_000;

export type CommentStreamStatus = 'idle' | 'connecting' | 'open' | 'error';

export interface CommentStreamState {
  status: CommentStreamStatus;
  newComments: ContributionPublic[];
  drain: () => ContributionPublic[];
}

function streamUrl(storyId: string): string {
  return `${API_BASE}/v1/stories/${encodeURIComponent(storyId)}/comments/stream`;
}

function parseEventData(data: string): unknown {
  try {
    return JSON.parse(data) as unknown;
  } catch {
    return null;
  }
}

export function useCommentStream(storyId: string | null | undefined): CommentStreamState {
  const [status, setStatus] = useState<CommentStreamStatus>('idle');
  const [newComments, setNewComments] = useState<ContributionPublic[]>([]);
  const bufferRef = useRef<ContributionPublic[]>([]);
  const retryRef = useRef(1_000);
  const retryTimerRef = useRef<number | null>(null);

  const drain = useCallback(() => {
    const drained = bufferRef.current;
    bufferRef.current = [];
    setNewComments([]);
    return drained;
  }, []);

  useEffect(() => {
    if (!storyId || typeof EventSource === 'undefined') {
      setStatus('idle');
      return;
    }

    let closed = false;
    let source: EventSource | null = null;

    const clearRetry = () => {
      if (retryTimerRef.current !== null) {
        window.clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
    };

    const connect = () => {
      if (closed) return;
      clearRetry();
      setStatus('connecting');
      source = new EventSource(streamUrl(storyId), { withCredentials: true });
      source.addEventListener('open', () => {
        retryRef.current = 1_000;
        setStatus('open');
      });
      source.addEventListener('comment', (event) => {
        const parsed = contributionPublicSchema.safeParse(parseEventData(event.data));
        if (!parsed.success) return;
        bufferRef.current = [...bufferRef.current, parsed.data];
        setNewComments(bufferRef.current);
      });
      source.addEventListener('error', () => {
        source?.close();
        source = null;
        if (closed) return;
        setStatus('error');
        const delay = retryRef.current;
        retryRef.current = Math.min(MAX_BACKOFF_MS, retryRef.current * 2);
        retryTimerRef.current = window.setTimeout(connect, delay);
      });
    };

    connect();
    return () => {
      closed = true;
      clearRetry();
      source?.close();
      source = null;
    };
  }, [storyId]);

  return { status, newComments, drain };
}
