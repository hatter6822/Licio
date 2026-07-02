// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Records the reader's absolute reply DEPTH for §5.3 traversal bucketing (a
// scored ActiveAttention dimension; WS-H PHI input) ONLY once the attached
// comment is actually SEEN. The story page renders its comment section BELOW
// THE FOLD, so recording on mount would credit thread traversal the reader
// never performed. Shared by BOTH the recursive `CommentNode` and the focused
// `AnchorComment` — the focused anchor is its own article (not a CommentNode),
// so it needs the same visibility-gated recording or a directly-focused deep
// comment with no rendered replies would contribute no depth at all.
import { useCallback } from 'react';
import { getSignalProcessor } from '../signals/runtime.js';

/**
 * Returns a callback ref: attach it to a comment's root element and the reader's
 * reply depth is recorded on the element's FIRST IntersectionObserver visibility
 * (then the observer disconnects; the React-19 ref cleanup tears it down on
 * detach). Where IntersectionObserver is unavailable (older engines / jsdom) it
 * falls back to recording on attach so the signal degrades gracefully.
 */
export function useRecordReplyDepth(
  storyId: string,
  depth: number,
): (node: HTMLElement | null) => (() => void) | undefined {
  return useCallback(
    (node: HTMLElement | null) => {
      if (node === null) return undefined;
      if (typeof IntersectionObserver === 'undefined') {
        getSignalProcessor().recordReplyDepth(storyId, depth);
        return undefined;
      }
      const observer = new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          getSignalProcessor().recordReplyDepth(storyId, depth);
          observer.disconnect();
        }
      });
      observer.observe(node);
      return () => observer.disconnect();
    },
    [storyId, depth],
  );
}
