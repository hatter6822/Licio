// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Optimized pgvector similarity helpers (WS-F.3.2d, SPEC §7 MERI / §10 SCOI).
// Every query: (1) anchors on the source entity's embedding for the ACTIVE
// model version, (2) orders by the `<=>` cosine-distance operator so the
// HNSW index drives the scan (WS-F.3.2b/e), (3) excludes the source entity
// itself, and (4) excludes hidden/retracted entities so similarity can never
// leak removed content. All values are bound parameters — never interpolated
// SQL. similarity = 1 − cosine_distance ∈ [−1, 1] (≈ [0, 1] for these
// non-negative-ish text embeddings).
//
// Query-time recall tuning (WS-F.3.2e): pass `efSearch` to raise pgvector's
// `hnsw.ef_search` for that query's transaction (SET LOCAL — never leaks
// outside). These helpers are exercised by the GATED integration tests
// (DATABASE_URL + pgvector) like every production Drizzle adapter.
import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

// biome-ignore lint/suspicious/noExplicitAny: helpers accept any schema-typed drizzle database
type Db = PostgresJsDatabase<any>;

export interface SimilarityHit {
  targetId: string;
  /** Cosine similarity (1 − distance), higher = more similar. */
  similarity: number;
}

export interface InterpretationDivergencePair {
  interpretationA: string;
  interpretationB: string;
  similarity: number;
}

function clampLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new RangeError(`limit must be an integer in [1, 200], got ${limit}`);
  }
  return limit;
}

function clampThreshold(threshold: number): number {
  if (!Number.isFinite(threshold) || threshold < -1 || threshold > 1) {
    throw new RangeError(`threshold must be in [-1, 1], got ${threshold}`);
  }
  return threshold;
}

async function withEfSearch<T>(db: Db, efSearch: number | undefined, run: (tx: Db) => Promise<T>) {
  if (efSearch === undefined) return run(db);
  if (!Number.isInteger(efSearch) || efSearch < 1 || efSearch > 1000) {
    throw new RangeError(`efSearch must be an integer in [1, 1000], got ${efSearch}`);
  }
  return db.transaction(async (tx) => {
    // Parameterized via set_config (SET LOCAL takes no bind parameters).
    await tx.execute(sql`select set_config('hnsw.ef_search', ${String(efSearch)}, true)`);
    return run(tx as unknown as Db);
  });
}

export interface SimilarityQueryOptions {
  threshold: number;
  limit: number;
  modelVersion: string;
  efSearch?: number | undefined;
}

/**
 * Stories with cosine similarity ≥ threshold to `storyId` (MERI duplicate /
 * independence checking). Hidden (takedown/safety) stories are excluded.
 */
export async function findSimilarStories(
  db: Db,
  storyId: string,
  options: SimilarityQueryOptions,
): Promise<SimilarityHit[]> {
  const limit = clampLimit(options.limit);
  const threshold = clampThreshold(options.threshold);
  return withEfSearch(db, options.efSearch, async (tx) => {
    const rows = (await tx.execute(sql`
      with query_vec as (
        select embedding from embeddings
        where target_type = 'story' and target_id = ${storyId}
          and model_version = ${options.modelVersion}
      )
      select e.target_id as target_id,
             1 - (e.embedding <=> q.embedding) as similarity
      from embeddings e
      join stories s on s.story_id = e.target_id
      cross join query_vec q
      where e.target_type = 'story'
        and e.model_version = ${options.modelVersion}
        and e.target_id <> ${storyId}
        and s.hidden_state is null
        and 1 - (e.embedding <=> q.embedding) >= ${threshold}
      order by e.embedding <=> q.embedding
      limit ${limit}
    `)) as unknown as Array<{ target_id: string; similarity: number }>;
    return rows.map((row) => ({ targetId: row.target_id, similarity: Number(row.similarity) }));
  });
}

/**
 * Claims with similar embeddings (MERI claim-level independence). Retracted
 * claims are excluded.
 */
export async function findSimilarClaims(
  db: Db,
  claimId: string,
  options: SimilarityQueryOptions,
): Promise<SimilarityHit[]> {
  const limit = clampLimit(options.limit);
  const threshold = clampThreshold(options.threshold);
  return withEfSearch(db, options.efSearch, async (tx) => {
    const rows = (await tx.execute(sql`
      with query_vec as (
        select embedding from embeddings
        where target_type = 'claim' and target_id = ${claimId}
          and model_version = ${options.modelVersion}
      )
      select e.target_id as target_id,
             1 - (e.embedding <=> q.embedding) as similarity
      from embeddings e
      join claims c on c.claim_id = e.target_id
      cross join query_vec q
      where e.target_type = 'claim'
        and e.model_version = ${options.modelVersion}
        and e.target_id <> ${claimId}
        and c.claim_status <> 'retracted'
        and 1 - (e.embedding <=> q.embedding) >= ${threshold}
      order by e.embedding <=> q.embedding
      limit ${limit}
    `)) as unknown as Array<{ target_id: string; similarity: number }>;
    return rows.map((row) => ({ targetId: row.target_id, similarity: Number(row.similarity) }));
  });
}

/**
 * Pairwise similarity among a story's community interpretations, LOW pairs
 * first (SCOI: low similarity = divergence = obstruction potential). The
 * interpretation ids are supplied by the caller — the CommunityInterpretation
 * entity is owned by WS-G.2; until it lands there is no story→interpretation
 * join to derive them from (documented seam, WS-F.3.2d).
 */
export async function findSimilarInterpretations(
  db: Db,
  interpretationIds: readonly string[],
  options: { divergenceThreshold: number; limit: number; modelVersion: string },
): Promise<InterpretationDivergencePair[]> {
  const limit = clampLimit(options.limit);
  const threshold = clampThreshold(options.divergenceThreshold);
  if (interpretationIds.length < 2) return [];
  // A raw `${array}` fragment expands to one parameter PER ELEMENT (a record,
  // not a PG array) — build an explicit array[$1, $2, …]::uuid[] constructor.
  const idsArray = sql`array[${sql.join(
    interpretationIds.map((id) => sql`${id}`),
    sql`, `,
  )}]::uuid[]`;
  const rows = (await db.execute(sql`
    select a.target_id as interpretation_a,
           b.target_id as interpretation_b,
           1 - (a.embedding <=> b.embedding) as similarity
    from embeddings a
    join embeddings b
      on b.target_type = 'community_interpretation'
     and b.model_version = ${options.modelVersion}
     and b.target_id = any(${idsArray})
     and a.target_id < b.target_id
    where a.target_type = 'community_interpretation'
      and a.model_version = ${options.modelVersion}
      and a.target_id = any(${idsArray})
      and 1 - (a.embedding <=> b.embedding) <= ${threshold}
    order by similarity asc
    limit ${limit}
  `)) as unknown as Array<{
    interpretation_a: string;
    interpretation_b: string;
    similarity: number;
  }>;
  return rows.map((row) => ({
    interpretationA: row.interpretation_a,
    interpretationB: row.interpretation_b,
    similarity: Number(row.similarity),
  }));
}

/** The evidence cards semantically nearest to a claim (no threshold). */
export async function findNearestEvidenceCards(
  db: Db,
  claimId: string,
  options: { limit: number; modelVersion: string; efSearch?: number | undefined },
): Promise<SimilarityHit[]> {
  const limit = clampLimit(options.limit);
  return withEfSearch(db, options.efSearch, async (tx) => {
    const rows = (await tx.execute(sql`
      with query_vec as (
        select embedding from embeddings
        where target_type = 'claim' and target_id = ${claimId}
          and model_version = ${options.modelVersion}
      )
      select e.target_id as target_id,
             1 - (e.embedding <=> q.embedding) as similarity
      from embeddings e
      join evidence_cards ec on ec.evidence_id = e.target_id
      cross join query_vec q
      where e.target_type = 'evidence_card'
        and e.model_version = ${options.modelVersion}
        and ec.verification_state <> 'retracted'
      order by e.embedding <=> q.embedding
      limit ${limit}
    `)) as unknown as Array<{ target_id: string; similarity: number }>;
    return rows.map((row) => ({ targetId: row.target_id, similarity: Number(row.similarity) }));
  });
}
