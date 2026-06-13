// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Search wire contracts (WS-F.3.1b, SPEC §21.2/§23.2). Keyword search over
// stories, claims, and evidence cards with filters (date, source, content
// type, topic, language), keyset pagination, and a stable sort (relevance,
// then recency, then id). Ranking is TEXTUAL relevance + recency only — no
// financial signal participates in indexing, filtering, or ordering
// (no-pay-to-rank, SPEC §13.6), and visibility filtering (safety-hidden /
// takedown-removed content) is enforced server-side.
import { z } from 'zod';
import { cursorSchema, isoTimestampSchema, paginatedSchema, uuidSchema } from './common.js';
import { bcp47Schema } from './story.js';

export const SEARCH_RESULT_TYPES = ['story', 'claim', 'evidence'] as const;
export type SearchResultType = (typeof SEARCH_RESULT_TYPES)[number];
export const searchResultTypeSchema = z.enum(SEARCH_RESULT_TYPES);

/** GET /v1/search query parameters (zod-validated; numbers coerced). */
export const searchRequestSchema = z
  .object({
    q: z.string().min(1).max(200),
    type: searchResultTypeSchema.optional(),
    topic_id: uuidSchema.optional(),
    source_id: uuidSchema.optional(),
    // WS-Q.2.5b — room-scoped search: when present, results are restricted to
    // this room's pool (public + room_only of THIS room). The caller must pass
    // the room read bar first (the route 404s otherwise). Absent ⇒ the GLOBAL
    // surface (public content from public rooms only — WS-Q.2.5a).
    room: uuidSchema.optional(),
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
  .strict();
export type SearchRequest = z.infer<typeof searchRequestSchema>;

/** One search hit: the public projection key + display fields + relevance. */
export const searchResultSchema = z
  .object({
    result_type: searchResultTypeSchema,
    /** story_id / claim_id / evidence_id depending on result_type. */
    id: uuidSchema,
    /** The story a claim/evidence hit belongs to (null for cross-story claims). */
    story_id: uuidSchema.nullable(),
    title: z.string().min(1).max(1_000),
    snippet: z.string().max(2_000).nullable(),
    /** Textual relevance (ts_rank_cd ≥ 0); for ordering, not a quality score. */
    relevance: z.number().min(0),
    created_at: isoTimestampSchema,
  })
  .strict();
export type SearchResult = z.infer<typeof searchResultSchema>;

export const searchResponseSchema = paginatedSchema(searchResultSchema);
export type SearchResponse = z.infer<typeof searchResponseSchema>;
