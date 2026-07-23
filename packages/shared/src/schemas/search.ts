// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Search wire contracts (WS-F.3.1b, SPEC §21.2/§23.2). Keyword search over ALL
// public content — stories, claims, comments (forum contributions), and public
// rooms — with filters (date, source, content type, topic, language), keyset
// pagination, and a stable sort (relevance, then recency, then id).  The same
// engine serves three SCOPES, selected by the mutually-exclusive `room` /
// `story` parameters: global public content (neither), one room's pool
// (`?room=`, WS-Q.2.5b), or one story's conversation (`?story=`, WS-T.7.3).
// Both scoped forms are gated by the corresponding read bar at the route.
// Ranking is
// TEXTUAL relevance + recency, weighted by the WS-T adjudication outcome only:
// a `validated` story/comment ranks higher at equal textual relevance and an
// `incorrect` one (a sourced correction prevailed against it) is filtered out
// entirely. No financial signal participates in indexing, filtering, or
// ordering (no-pay-to-rank, SPEC §13.6), and visibility filtering
// (safety-hidden / takedown-removed / non-public / private-room content) is
// enforced server-side.
import { z } from 'zod';
import { isSentinelTopicId } from '../constants/topics.js';
import { cursorSchema, isoTimestampSchema, paginatedSchema, uuidSchema } from './common.js';
import { bcp47Schema } from './story.js';

export const SEARCH_RESULT_TYPES = ['story', 'claim', 'comment', 'room'] as const;
export type SearchResultType = (typeof SEARCH_RESULT_TYPES)[number];
export const searchResultTypeSchema = z.enum(SEARCH_RESULT_TYPES);

function isSearchResultType(value: string): value is SearchResultType {
  return (SEARCH_RESULT_TYPES as readonly string[]).includes(value);
}

/** GET /v1/search query parameters (zod-validated; numbers coerced). */
export const searchRequestSchema = z
  .object({
    q: z.string().min(1).max(200),
    /** Restrict to these result types (a comma-separated list, e.g.
     *  `type=story,comment,room`; a bare `type=story` still works). Absent ⇒
     *  every corpus. Duplicates collapse; an unknown type is a 400. */
    type: z
      .string()
      .transform((value, ctx) => {
        const parts = [...new Set(value.split(',').map((part) => part.trim()))].filter(
          (part) => part.length > 0,
        );
        if (parts.length === 0 || !parts.every(isSearchResultType)) {
          ctx.addIssue({
            code: 'custom',
            message: `type must be a comma-separated list of: ${SEARCH_RESULT_TYPES.join(', ')}`,
          });
          return z.NEVER;
        }
        return parts as SearchResultType[];
      })
      .optional(),
    // The UNCLASSIFIED sentinel is NOT a subject topic (SPEC §24.1) — it stands
    // in for "no validated topic". Rejecting it at the boundary stops a caller
    // filtering `?topic_id=<sentinel>` and getting every unclassified story back
    // as one pseudo-topic (the in-memory `topicIds.includes` and the Drizzle
    // `topic_ids @> array[…]` filters both key off this value).
    topic_id: uuidSchema
      .refine((value) => !isSentinelTopicId(value), {
        message: 'topic_id must be a real subject topic, not the unclassified sentinel',
      })
      .optional(),
    source_id: uuidSchema.optional(),
    // WS-Q.2.5b — room-scoped search: when present, results are restricted to
    // this room's pool (public + room_only of THIS room). The caller must pass
    // the room read bar first (the route 404s otherwise). Absent ⇒ the GLOBAL
    // surface (public content from public rooms only — WS-Q.2.5a).
    room: uuidSchema.optional(),
    // WS-T.7.3 — story-scoped search: when present, results are restricted to
    // the CONVERSATION on this story (its comments). The story record itself is
    // the page the caller is already on and rooms are not story content, so
    // neither corpus participates. The caller must pass the story read bar
    // first (the route 404s otherwise — the same tier-two bar the story detail
    // and comment reads enforce).
    story: uuidSchema.optional(),
    language: bcp47Schema.optional(),
    date_from: isoTimestampSchema.optional(),
    date_to: isoTimestampSchema.optional(),
    /** Prefix-match the final term (typeahead mode, WS-F.3.1a). */
    prefix: z
      .enum(['true', 'false'])
      .optional()
      .transform((value) => value === 'true'),
    cursor: cursorSchema.optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  })
  .strict()
  // The two scopes are alternatives, not a conjunction: a story already sits in
  // exactly one room, so `?room=&story=` expresses nothing the story scope does
  // not, and silently letting one win would make the read bar the route
  // enforces ambiguous. Reject the combination at the boundary instead.
  .refine((value) => value.room === undefined || value.story === undefined, {
    message: 'room and story are mutually exclusive scopes',
    path: ['story'],
  });
export type SearchRequest = z.infer<typeof searchRequestSchema>;

/** The WS-T dispute postures a search hit may carry. `incorrect` is absent BY
 *  CONTRACT: adjudicated-incorrect content is filtered out of search entirely,
 *  so a result can never carry it. */
export const SEARCH_RESULT_DISPUTE_STATUSES = ['none', 'under_debate', 'validated'] as const;
export const searchResultDisputeStatusSchema = z.enum(SEARCH_RESULT_DISPUTE_STATUSES);
export type SearchResultDisputeStatus = (typeof SEARCH_RESULT_DISPUTE_STATUSES)[number];

/** One search hit: the public projection key + display fields + relevance. */
export const searchResultSchema = z
  .object({
    result_type: searchResultTypeSchema,
    /** story_id / claim_id / contribution_id / room_id depending on result_type. */
    id: uuidSchema,
    /** The owning story — the client navigation key for non-room hits: the
     *  story itself for a `story` hit, the parent story for a `comment` hit,
     *  the claim's story for a `claim` hit (null for cross-story claims), and
     *  null for a `room` hit. */
    story_id: uuidSchema.nullable(),
    /** Display title. A `comment` hit carries its PARENT STORY's title (the
     *  comment has none of its own); matching is over the comment body only. */
    title: z.string().min(1).max(1_000),
    snippet: z.string().max(2_000).nullable(),
    /** Textual relevance (ts_rank_cd ≥ 0, × the WS-T validation weight); for
     *  ordering, not a quality score. */
    relevance: z.number().min(0),
    created_at: isoTimestampSchema,
    /** WS-T adjudication posture (`validated` outranks equal-relevance peers;
     *  `incorrect` never surfaces). Always `none` for claim/room hits. */
    dispute_status: searchResultDisputeStatusSchema,
  })
  .strict();
export type SearchResult = z.infer<typeof searchResultSchema>;

export const searchResponseSchema = paginatedSchema(searchResultSchema);
export type SearchResponse = z.infer<typeof searchResponseSchema>;
