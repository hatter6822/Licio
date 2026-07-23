// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Search service (WS-F.3.1a/b, SPEC §21.2): the SearchIndex interface + the
// in-memory implementation whose semantics mirror the Postgres FTS adapter
// (drizzle-ingestion-stores.ts): textual relevance with title-over-body
// weighting, recency tiebreak, prefix mode for typeahead, filters, keyset
// pagination, and SERVER-SIDE visibility (hidden stories, retracted content,
// non-published comments, and non-public rooms never appear). One engine serves
// all three scopes — global, room (`?room=`), and story (`?story=`) — so a
// scoped query inherits every ranking and visibility rule unchanged. The corpus is
// ALL public content: stories + claims (the ingestion stores) plus comments +
// rooms (supplied by the forum boot through the late-bound corpus hook).
// Ranking inputs are textual relevance + recency, weighted ONLY by the WS-T
// adjudication outcome (`validated` multiplies relevance by
// SEARCH_VALIDATED_BOOST; `incorrect` is excluded outright) — no financial
// signal exists in any input type (no-pay-to-rank, §13.6), and user query
// strings are tokenized, never concatenated into SQL.
import type { ContributionDisputeStatus, SearchRequest, SearchResult } from '@licio/shared';

/** The resolved (optional) viewer, threaded through by the route — NEVER part
 *  of the wire request. WS-J.1.2: comment hits by a blocked∪muted author are
 *  excluded for that viewer, mirroring the comment read path's enforcement
 *  (viewerHideSet + visibleRows) so search can't resurface what the
 *  destination surface hides (and then 404 on click-through). */
export interface SearchViewerContext {
  hiddenAuthorIds?: ReadonlySet<string>;
}

export interface SearchIndex {
  search(
    request: SearchRequest,
    viewer?: SearchViewerContext,
  ): Promise<{ items: SearchResult[]; nextCursor: string | null }>;
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

const CURSOR_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Decode + VALIDATE a client-supplied cursor. Every component is checked —
 * not just the relevance — because the Drizzle adapter binds `createdAt` and
 * `id` into `::timestamptz` / `::uuid` casts: a tampered cursor must decode
 * to null (served as page one) rather than surface as a SQL cast error (a
 * caller-triggerable 500 the in-memory adapter would not reproduce).
 */
export function decodeSearchCursor(
  cursor: string,
): { relevance: number; createdAt: string; id: string } | null {
  try {
    const [relevance, createdAt, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
    if (relevance === undefined || createdAt === undefined || id === undefined) return null;
    const parsed = Number(relevance);
    if (!Number.isFinite(parsed)) return null;
    if (Number.isNaN(Date.parse(createdAt))) return null;
    if (!CURSOR_ID_RE.test(id)) return null;
    return { relevance: parsed, createdAt, id };
  } catch {
    return null;
  }
}

/**
 * WS-T validation weighting: a `validated` story/comment (a challenge debate
 * upheld it) multiplies its textual relevance by this factor, so at comparable
 * relevance the adjudicated-correct document outranks its unvalidated peers —
 * a correctness signal, never popularity. The Drizzle adapter applies the SAME
 * constant in SQL; the two indexes must order identically for keyset cursors.
 */
export const SEARCH_VALIDATED_BOOST = 1.25;

/** Comment-hit snippet bound (characters of body). The forum corpus provider
 *  and the Drizzle adapter's `left(body, N)` must agree so both indexes serve
 *  the same projection. */
export const SEARCH_COMMENT_SNIPPET_LENGTH = 280;

/** One indexable document (the in-memory analogue of a tsvector row). */
export interface SearchDocument {
  resultType: 'story' | 'claim' | 'comment' | 'room';
  id: string;
  storyId: string | null;
  /** The SCORED title field (the tsvector A-weight analogue). EMPTY for a
   *  comment — a Postgres generated column can reference only its own row's
   *  columns (the body), so the in-memory index must not match on the parent
   *  story's title either (the story corpus covers those matches). */
  title: string;
  body: string;
  snippet: string | null;
  /** Display-only title override (a comment hit shows its parent story's
   *  title). Falls back to `title` when absent. */
  displayTitle?: string;
  /** The author the WS-J.1.2 viewer hide set keys on. Set ONLY for comment
   *  documents (contribution.userId; null = tombstoned author): the comment
   *  read path is the surface that block/mute-filters by author, and search
   *  mirrors exactly that — story/claim/room documents carry null and are
   *  never author-filtered (their read surfaces aren't either). */
  authorUserId: string | null;
  /** WS-T dispute posture. `incorrect` documents are EXCLUDED at query time
   *  (adjudicated-incorrect content never surfaces in search); `validated`
   *  earns the SEARCH_VALIDATED_BOOST multiplier. Claims and rooms carry
   *  `none` (WS-T does not apply to them). */
  disputeStatus: ContributionDisputeStatus;
  topicIds: readonly string[];
  sourceId: string | null;
  language: string | null;
  createdAt: string;
  /** Not hidden (takedown/safety) and not retracted (the existing bar). */
  visible: boolean;
  // WS-Q.2.5a/b — the two-tier visibility coordinates of the owning story.
  /** The home room of the owning story (null only for legacy/orphan rows). */
  roomId: string | null;
  /** The owning story's item visibility (§14.5). */
  storyVisibility: 'public' | 'room_only';
  /** The home room's visibility (§16.1). */
  roomVisibility: 'public' | 'private';
  /** WS-S.1.4 — the home room's storage mode.  Server search indexes + serves
   *  ONLY `server`-storage rooms (PRIVATE_SPEC §23.6); a Private P2P room's
   *  content never reaches the index. */
  roomStorageMode: 'server' | 'p2p';
}

/** Wire projection of a document's dispute posture. Total over the full enum
 *  so the mapper stays honest, but `incorrect` is unreachable here — those
 *  documents are excluded before scoring (the search() dispute filter). */
function resultDisputeStatus(status: ContributionDisputeStatus): SearchResult['dispute_status'] {
  return status === 'incorrect' ? 'none' : status;
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

  async search(request: SearchRequest, viewer?: SearchViewerContext) {
    const tokens = tokenizeQuery(request.q);
    const cursor = request.cursor !== undefined ? decodeSearchCursor(request.cursor) : null;
    const hiddenAuthors = viewer?.hiddenAuthorIds;
    const scored: Array<{ doc: SearchDocument; relevance: number }> = [];
    for (const doc of await this.#documents()) {
      if (!doc.visible) continue;
      // WS-J.1.2 — the viewer's blocked∪muted authors never surface (comment
      // documents only; every other type carries a null author by design).
      if (
        hiddenAuthors !== undefined &&
        doc.authorUserId !== null &&
        hiddenAuthors.has(doc.authorUserId)
      ) {
        continue;
      }
      // WS-S.1.4 — server search NEVER returns Private P2P content (§23.6); a
      // p2p doc should never be indexed, so this is defense in depth at query.
      if (doc.roomStorageMode !== 'server') continue;
      // WS-Q.2.5a/b + WS-T.7.3 — the three scopes:
      //   • story-scoped (`?story=`): only the CONVERSATION on this story (its
      //     comments); the route has already enforced the story read bar.
      //   • room-scoped (`?room=`): only this room's pool (public + room_only of
      //     THIS room); the route has already enforced the room read bar.
      //   • global (neither): only PUBLIC content from PUBLIC rooms — BOTH
      //     conjuncts (defense-in-depth: a mislabeled public story in a private
      //     room, or a migration-transient row, is excluded even from a reader
      //     who could pass that room's bar).
      if (request.story !== undefined) {
        if (doc.storyId !== request.story) continue;
        // The story record itself is the page the reader is already on, and a
        // room is not story content — the conversation is the whole corpus here
        // (the Drizzle adapter skips the same corpora).
        if (doc.resultType !== 'comment') continue;
      } else if (request.room !== undefined) {
        if (doc.roomId !== request.room) continue;
        // A room-scoped query searches the room's CONTENT — the room record
        // itself is not content (the Drizzle adapter skips its rooms corpus
        // the same way).
        if (doc.resultType === 'room') continue;
      } else if (doc.storyVisibility !== 'public' || doc.roomVisibility !== 'public') {
        continue;
      }
      // WS-T: adjudicated-incorrect content (a sourced correction prevailed
      // against it) is filtered OUT of search entirely — it stays readable in
      // place (visible-but-sunk, §15.4) but is never surfaced as a result.
      if (doc.disputeStatus === 'incorrect') continue;
      if (request.type !== undefined && !request.type.includes(doc.resultType)) continue;
      if (request.topic_id !== undefined && !doc.topicIds.includes(request.topic_id)) continue;
      if (request.source_id !== undefined && doc.sourceId !== request.source_id) continue;
      if (request.language !== undefined && doc.language !== request.language) continue;
      if (request.date_from !== undefined && doc.createdAt < request.date_from) continue;
      if (request.date_to !== undefined && doc.createdAt >= request.date_to) continue;
      const textual = scoreDocument(doc, tokens, request.prefix === true);
      if (textual <= 0) continue;
      const relevance =
        doc.disputeStatus === 'validated' ? textual * SEARCH_VALIDATED_BOOST : textual;
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
      title: (doc.displayTitle ?? doc.title).slice(0, 1000),
      // Bound to the wire schema's snippet max exactly like the Drizzle
      // adapter — the route re-validates the response, so an over-long
      // snippet would otherwise become a 500 in this adapter only.
      snippet: doc.snippet === null ? null : doc.snippet.slice(0, 2000),
      relevance,
      created_at: doc.createdAt,
      dispute_status: resultDisputeStatus(doc.disputeStatus),
    }));
    const last = page.at(-1);
    const nextCursor =
      afterCursor.length > request.limit && last !== undefined
        ? encodeSearchCursor(last.relevance, last.doc.createdAt, last.doc.id)
        : null;
    return { items, nextCursor };
  }
}
