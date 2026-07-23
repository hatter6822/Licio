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
 * Where a search runs. `null` (the absence of a scope) is the GLOBAL surface.
 * A scope carries the display `label` alongside its id so the modal can name
 * the boundary it is searching within without a second fetch (the banner that
 * opened it already has the name in hand).
 */
export type SearchScope =
  | { readonly kind: 'room'; readonly roomId: string; readonly label: string }
  | { readonly kind: 'story'; readonly storyId: string; readonly label: string };

/**
 * The scopes a surface OFFERS, in menu order — the first is the initial
 * selection, and the global surface is always appended by the modal.
 *
 * A scope is a DEFAULT, never a cage: opening search from a room should search
 * that room because that is almost always the intent, but a reader who does not
 * find what they wanted must be able to widen to the whole site (or step out to
 * the surrounding room) without closing the dialog, retyping, and navigating
 * somewhere else first. So a surface declares everything it can name — a story
 * offers its conversation AND its home room — and the reader picks.
 *
 * An empty list is the front page: no page context, so global is the only
 * option and the modal shows no scope control at all.
 */
export type SearchScopeOptions = readonly SearchScope[];

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

/**
 * The scope menu a STORY surface offers: its own conversation first (the
 * default — a reader searching from a story page means this discussion), then
 * the surrounding room once that room's name is known. The modal appends the
 * global surface, so the three together let a reader widen one level at a time
 * instead of jumping straight to the whole site.
 *
 * Shared by the story page and its dedicated comments page so the two can never
 * offer different menus for the same story.
 */
export function storySearchScopes(
  story: { readonly id: string; readonly title: string },
  room: { readonly id: string; readonly name: string } | null,
): SearchScopeOptions {
  const conversation: SearchScope = { kind: 'story', storyId: story.id, label: story.title };
  return room === null
    ? [conversation]
    : [conversation, { kind: 'room', roomId: room.id, label: room.name }];
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
