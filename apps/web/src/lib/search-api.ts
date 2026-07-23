// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Public-content search API (WS-F.3.1b): the typed RPC call behind the search
// modal. The SAME engine serves three scopes — global public content, one
// room's pool (WS-Q.2.5b `?room=`), and one story's conversation (WS-T.7.3
// `?story=`) — so a scoped search inherits every server-side ranking and
// visibility rule unchanged: PUBLIC content only at the global tier, the read
// bar enforced server-side for the two scoped tiers, WS-T `validated` results
// weighted up, adjudicated `incorrect` content filtered out. The client adds
// nothing to that ranking; it only names the scope.
import { type SearchResponse, type SearchResultType, searchResponseSchema } from '@licio/shared';
import { client, parseResponse } from './api.js';

/**
 * The result types the modal queries: the client-REACHABLE public content
 * planes (each has a destination page). Claims stay an internal MERI/WS-K
 * model — the per-story claims surface was retired with the comment-centric
 * sourcing redesign — so the modal never requests them.
 */
export const MODAL_SEARCH_TYPES: readonly SearchResultType[] = ['story', 'comment', 'room'];

/** Below this the modal shows the "keep typing" hint instead of querying. */
export const SEARCH_MIN_QUERY_LENGTH = 2;

/**
 * Where a search runs. `null` (the absence of a scope) is the GLOBAL surface —
 * the front page's search. A scope carries the display `label` alongside its
 * id so the modal can name the boundary it is searching within without a
 * second fetch (the banner that opened it already has the name in hand).
 */
export type SearchScope =
  | { readonly kind: 'room'; readonly roomId: string; readonly label: string }
  | { readonly kind: 'story'; readonly storyId: string; readonly label: string };

/**
 * The result types each scope can return — the client mirror of the server's
 * per-scope corpora (`InMemorySearchIndex.search`). A room-scoped query
 * searches the room's CONTENT (the room record itself is not a result), and a
 * story-scoped one searches only that story's conversation.
 */
export function scopeSearchTypes(scope: SearchScope | null): readonly SearchResultType[] {
  if (scope === null) return MODAL_SEARCH_TYPES;
  return scope.kind === 'room' ? (['story', 'comment'] as const) : (['comment'] as const);
}

/** A stable, serializable cache-key fragment for a scope (`queryKeys.search`). */
export function scopeKey(scope: SearchScope | null): string {
  if (scope === null) return 'global';
  return scope.kind === 'room' ? `room:${scope.roomId}` : `story:${scope.storyId}`;
}

export async function searchContent(
  q: string,
  types: readonly SearchResultType[],
  scope: SearchScope | null,
  signal?: AbortSignal,
): Promise<SearchResponse> {
  // The wire schema is `.strict()` AND rejects `room` + `story` together, so a
  // scope contributes EXACTLY one key and an unscoped search contributes none.
  const scopeQuery =
    scope === null ? {} : scope.kind === 'room' ? { room: scope.roomId } : { story: scope.storyId };
  const response = await client.v1.search.$get(
    // Prefix mode makes the final term a typeahead prefix, so results appear
    // while the reader is still finishing a word.
    { query: { q, type: types.join(','), prefix: 'true', ...scopeQuery } },
    signal ? { init: { signal } } : undefined,
  );
  return parseResponse(response, searchResponseSchema);
}
