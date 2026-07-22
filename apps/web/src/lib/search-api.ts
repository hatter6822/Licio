// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Public-content search API (WS-F.3.1b): the typed RPC call behind the search
// modal. Global tier only — the server serves PUBLIC content from PUBLIC
// rooms, weights WS-T `validated` results up, and filters adjudicated
// `incorrect` content out entirely; the client adds nothing to that ranking.
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

export async function searchContent(
  q: string,
  types: readonly SearchResultType[],
  signal?: AbortSignal,
): Promise<SearchResponse> {
  const response = await client.v1.search.$get(
    // Prefix mode makes the final term a typeahead prefix, so results appear
    // while the reader is still finishing a word.
    { query: { q, type: types.join(','), prefix: 'true' } },
    signal ? { init: { signal } } : undefined,
  );
  return parseResponse(response, searchResponseSchema);
}
