// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Search service (WS-F.3.1a/b, SPEC §21.2): the SearchIndex interface + the
// in-memory implementation whose semantics mirror the Postgres FTS adapter
// (drizzle-ingestion-stores.ts): textual relevance with title-over-body
// weighting, recency tiebreak, prefix mode for typeahead, filters, keyset
// pagination, and SERVER-SIDE visibility (hidden stories and retracted
// content never appear). Ranking inputs are textual relevance + recency
// ONLY — no financial signal exists in any input type (no-pay-to-rank,
// §13.6), and user query strings are tokenized, never concatenated into SQL.
import type { SearchRequest, SearchResult } from '@licio/shared';

export interface SearchIndex {
  search(request: SearchRequest): Promise<{ items: SearchResult[]; nextCursor: string | null }>;
}

/** Unicode-aware tokenization — the ONLY thing a user query is turned into.
 *  (The Drizzle adapter quotes each token into a tsquery; no operator or
 *  quote characters can survive tokenization — injection-safe.) */
export function tokenizeQuery(query: string): string[] {
  return (query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, 12);
}

/** Opaque cursor: base64url of `relevance|created_at|id` (keyset). */
export function encodeSearchCursor(relevance: number, createdAt: string, id: string): string {
  return Buffer.from(`${relevance}|${createdAt}|${id}`, 'utf8').toString('base64url');
}

export function decodeSearchCursor(
  cursor: string,
): { relevance: number; createdAt: string; id: string } | null {
  try {
    const [relevance, createdAt, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
    if (relevance === undefined || createdAt === undefined || id === undefined) return null;
    const parsed = Number(relevance);
    if (!Number.isFinite(parsed)) return null;
    return { relevance: parsed, createdAt, id };
  } catch {
    return null;
  }
}

/** One indexable document (the in-memory analogue of a tsvector row). */
export interface SearchDocument {
  resultType: 'story' | 'claim' | 'evidence';
  id: string;
  storyId: string | null;
  title: string;
  body: string;
  snippet: string | null;
  topicIds: readonly string[];
  sourceId: string | null;
  language: string | null;
  createdAt: string;
  visible: boolean;
}

/** Title hits weigh A=1.0, body hits B=0.4 (mirrors setweight A/B). */
const TITLE_WEIGHT = 1.0;
const BODY_WEIGHT = 0.4;

export function scoreDocument(
  doc: SearchDocument,
  tokens: readonly string[],
  prefix: boolean,
): number {
  if (tokens.length === 0) return 0;
  const title = doc.title.toLowerCase();
  const body = doc.body.toLowerCase();
  const titleTokens = new Set(title.match(/[\p{L}\p{N}]+/gu) ?? []);
  const bodyTokens = new Set(body.match(/[\p{L}\p{N}]+/gu) ?? []);
  let score = 0;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] as string;
    const isLast = i === tokens.length - 1;
    const matchesSet = (set: Set<string>) =>
      set.has(token) ||
      (prefix && isLast && [...set].some((candidate) => candidate.startsWith(token)));
    const inTitle = matchesSet(titleTokens);
    const inBody = matchesSet(bodyTokens);
    if (!inTitle && !inBody) return 0; // AND semantics (websearch_to_tsquery)
    if (inTitle) score += TITLE_WEIGHT;
    if (inBody) score += BODY_WEIGHT;
  }
  return score;
}

/**
 * In-memory search over documents supplied by a provider closure (the
 * service container wires it to the live stores). Stable total order:
 * relevance DESC, created_at DESC, id DESC — identical to the SQL adapter,
 * so pagination behaves the same in both.
 */
export class InMemorySearchIndex implements SearchIndex {
  readonly #documents: () => Promise<SearchDocument[]>;

  constructor(documents: () => Promise<SearchDocument[]>) {
    this.#documents = documents;
  }

  async search(request: SearchRequest) {
    const tokens = tokenizeQuery(request.q);
    const cursor = request.cursor !== undefined ? decodeSearchCursor(request.cursor) : null;
    const scored: Array<{ doc: SearchDocument; relevance: number }> = [];
    for (const doc of await this.#documents()) {
      if (!doc.visible) continue;
      if (request.type !== undefined && doc.resultType !== request.type) continue;
      if (request.topic_id !== undefined && !doc.topicIds.includes(request.topic_id)) continue;
      if (request.source_id !== undefined && doc.sourceId !== request.source_id) continue;
      if (request.language !== undefined && doc.language !== request.language) continue;
      if (request.date_from !== undefined && doc.createdAt < request.date_from) continue;
      if (request.date_to !== undefined && doc.createdAt >= request.date_to) continue;
      const relevance = scoreDocument(doc, tokens, request.prefix === true);
      if (relevance <= 0) continue;
      scored.push({ doc, relevance });
    }
    scored.sort(
      (a, b) =>
        b.relevance - a.relevance ||
        b.doc.createdAt.localeCompare(a.doc.createdAt) ||
        b.doc.id.localeCompare(a.doc.id),
    );
    const afterCursor = cursor
      ? scored.filter(
          ({ doc, relevance }) =>
            relevance < cursor.relevance ||
            (relevance === cursor.relevance && doc.createdAt < cursor.createdAt) ||
            (relevance === cursor.relevance &&
              doc.createdAt === cursor.createdAt &&
              doc.id < cursor.id),
        )
      : scored;
    const page = afterCursor.slice(0, request.limit);
    const items: SearchResult[] = page.map(({ doc, relevance }) => ({
      result_type: doc.resultType,
      id: doc.id,
      story_id: doc.storyId,
      title: doc.title.slice(0, 1000),
      snippet: doc.snippet,
      relevance,
      created_at: doc.createdAt,
    }));
    const last = page.at(-1);
    const nextCursor =
      afterCursor.length > request.limit && last !== undefined
        ? encodeSearchCursor(last.relevance, last.doc.createdAt, last.doc.id)
        : null;
    return { items, nextCursor };
  }
}
