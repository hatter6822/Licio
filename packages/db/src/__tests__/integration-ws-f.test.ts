// SPDX-License-Identifier: AGPL-3.0-or-later
//
// GATED live-Postgres integration tests for the WS-F content schema. Run only
// when DATABASE_URL points at a pgvector-enabled Postgres (docker-compose
// ships pgvector/pgvector:pg16); skipped in CI. They validate what unit tests
// cannot: the migration chain (including CREATE EXTENSION vector) applies,
// the partial unique index / CHECK constraints / generated tsvector columns
// fire, FTS + GIN and pgvector + HNSW use their indexes, and the similarity
// helpers return mathematically correct cosine ordering.
//
//   DATABASE_URL=postgres://licio:licio_dev@localhost:5432/licio_dev pnpm test
import { randomUUID } from 'node:crypto';
import {
  defaultPersonalizationSettings,
  defaultPrivacySettings,
  emptyReputationSummary,
} from '@licio/shared';
import { sql } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as schema from '../schema/index.js';
import {
  claims,
  EMBEDDING_DIMENSION,
  embeddings,
  evidenceCards,
  sourceSyndications,
  sources,
  stories,
  storyFreshness,
  storySignatures,
  threads,
  users,
} from '../schema/index.js';
import {
  findNearestEvidenceCards,
  findSimilarClaims,
  findSimilarInterpretations,
  findSimilarStories,
} from '../similarity.js';

const DB_URL = process.env['DATABASE_URL'];

function must<T>(value: T | undefined, message = 'expected a row'): T {
  if (value === undefined) throw new Error(message);
  return value;
}

/** A unit vector with weight concentrated on `axis` (cosine-friendly). */
function unitVector(axis: number, blend = 0): number[] {
  const v = new Array<number>(EMBEDDING_DIMENSION).fill(0);
  v[axis % EMBEDDING_DIMENSION] = 1 - blend;
  v[(axis + 1) % EMBEDDING_DIMENSION] = blend;
  const norm = Math.sqrt(v.reduce((sum, x) => sum + x * x, 0));
  return v.map((x) => x / norm);
}

describe.skipIf(!DB_URL)('WS-F Postgres integration', () => {
  let client: ReturnType<typeof postgres>;
  let db: PostgresJsDatabase<typeof schema>;
  let submitterId: string;

  beforeAll(async () => {
    client = postgres(DB_URL as string, { max: 1 });
    db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: new URL('../../drizzle', import.meta.url).pathname });
    const user = must(
      (
        await db
          .insert(users)
          .values({
            handle: `wsf_${randomUUID().slice(0, 8)}`,
            displayName: 'WS-F Integration',
            email: null,
            ageBandIfKnown: 'adult',
            privacySettings: defaultPrivacySettings(),
            personalizationSettings: defaultPersonalizationSettings(),
            reputationSummaryPrivate: emptyReputationSummary(),
          })
          .returning()
      )[0],
    );
    submitterId = user.userId;
  });

  afterAll(async () => {
    // ROW-SCOPED cleanup: vitest projects run in parallel against the SAME
    // live database (the api package's gated WS-F suite shares these tables),
    // so deletions are bounded to this suite's rows — dependents first.
    const storyIds = (
      await db
        .select({ id: stories.storyId })
        .from(stories)
        .where(sql`${stories.submittedBy} = ${submitterId}`)
    ).map((r) => r.id);
    for (const version of ['v-test-1', 'v-test-2', 'v-claims-1']) {
      await db.execute(sql`delete from embeddings where model_version = ${version}`);
    }
    await db.delete(evidenceCards).where(sql`${evidenceCards.submittedBy} = ${submitterId}`);
    const uuidArray = (ids: readonly string[]) =>
      sql`array[${sql.join(
        ids.map((id) => sql`${id}`),
        sql`, `,
      )}]::uuid[]`;
    if (createdClaimIds.length > 0) {
      await db.execute(sql`delete from claims where claim_id = any(${uuidArray(createdClaimIds)})`);
    }
    if (storyIds.length > 0) {
      await db.execute(sql`delete from claims where story_id = any(${uuidArray(storyIds)})`);
      await db.execute(sql`delete from threads where story_id = any(${uuidArray(storyIds)})`);
      await db.execute(sql`delete from stories where story_id = any(${uuidArray(storyIds)})`);
    }
    if (createdSourceIds.length > 0) {
      await db.execute(
        sql`delete from source_syndications where from_source_id = any(${uuidArray(createdSourceIds)}) or to_source_id = any(${uuidArray(createdSourceIds)})`,
      );
      await db.execute(
        sql`delete from sources where source_id = any(${uuidArray(createdSourceIds)})`,
      );
    }
    await db.delete(users).where(sql`${users.userId} = ${submitterId}`);
    await client?.end();
  });

  /** Rows created outside the submitter graph (scoped cleanup). */
  const createdSourceIds: string[] = [];
  const createdClaimIds: string[] = [];

  function storyInsert(over: Partial<typeof stories.$inferInsert> = {}) {
    return {
      title: 'Integration story title',
      titleHash: randomUUID().replaceAll('-', ''),
      submittedBy: submitterId,
      topicIds: [randomUUID()],
      submissionType: 'original_brief' as const,
      submissionMetadata: {
        submission_type: 'original_brief' as const,
        body: 'Body text for the integration story.',
      },
      ...over,
    };
  }

  it('pgvector extension is installed by the migration chain (WS-F.3.2b)', async () => {
    const rows = await db.execute(sql`select extname from pg_extension where extname = 'vector'`);
    expect(rows.length).toBe(1);
  });

  it('round-trips a story and enforces the partial unique canonical_url (WS-F.1.1a)', async () => {
    // Many NULL canonical URLs coexist (non-link types)…
    const a = must((await db.insert(stories).values(storyInsert()).returning())[0]);
    const b = must((await db.insert(stories).values(storyInsert()).returning())[0]);
    expect(a.storyId).not.toBe(b.storyId);
    expect(a.lifecycleState).toBe('submitted');

    // …but a duplicate non-null canonical URL is rejected by the index.
    const url = `https://example.com/${randomUUID()}`;
    await db.insert(stories).values(storyInsert({ canonicalUrl: url }));
    await expect(db.insert(stories).values(storyInsert({ canonicalUrl: url }))).rejects.toThrow();
  });

  it('rejects empty topic_ids and over-long titles via CHECK constraints', async () => {
    await expect(db.insert(stories).values(storyInsert({ topicIds: [] }))).rejects.toThrow();
    await expect(
      db.insert(stories).values(storyInsert({ title: 'x'.repeat(301) })),
    ).rejects.toThrow();
  });

  it('uses the GIN index for topic containment and the partial unique for URL lookups', async () => {
    const topic = randomUUID();
    await db.insert(stories).values(storyInsert({ topicIds: [topic] }));
    const [topicPlan, urlPlan] = await Promise.all([
      client.unsafe(
        `SET LOCAL enable_seqscan = off; EXPLAIN SELECT story_id FROM stories WHERE topic_ids @> ARRAY['${topic}']::uuid[]`,
      ),
      client.unsafe(
        `SET LOCAL enable_seqscan = off; EXPLAIN SELECT story_id FROM stories WHERE canonical_url = 'https://example.com/x'`,
      ),
    ]);
    expect(JSON.stringify(topicPlan)).toMatch(/stories_topic_gin/);
    expect(JSON.stringify(urlPlan)).toMatch(/stories_canonical_url_uq/);
  });

  it('populates the weighted generated tsvector and ranks title over excerpt (WS-F.3.1a)', async () => {
    const titleHit = must(
      (
        await db
          .insert(stories)
          .values(storyInsert({ title: 'Quantum reservoir breakthrough', excerpt: 'Other text.' }))
          .returning()
      )[0],
    );
    const excerptHit = must(
      (
        await db
          .insert(stories)
          .values(
            storyInsert({
              title: 'A different headline',
              excerpt: 'The quantum reservoir appears in the body only.',
            }),
          )
          .returning()
      )[0],
    );
    const rows = (await db.execute(sql`
      select story_id, ts_rank_cd(search_tsv, websearch_to_tsquery('simple', 'quantum reservoir')) as rank
      from stories
      where search_tsv @@ websearch_to_tsquery('simple', 'quantum reservoir')
      order by rank desc
    `)) as unknown as Array<{ story_id: string; rank: number }>;
    const ids = rows.map((r) => r.story_id);
    expect(ids).toContain(titleHit.storyId);
    expect(ids).toContain(excerptHit.storyId);
    expect(ids.indexOf(titleHit.storyId)).toBeLessThan(ids.indexOf(excerptHit.storyId));

    const plan = await client.unsafe(
      `SET LOCAL enable_seqscan = off; EXPLAIN SELECT story_id FROM stories WHERE search_tsv @@ websearch_to_tsquery('simple', 'quantum')`,
    );
    expect(JSON.stringify(plan)).toMatch(/stories_search_gin/);
  });

  it('creates story + thread shell transactionally; rollback leaves no orphan (WS-F.1.4d)', async () => {
    const url = `https://example.com/tx-${randomUUID()}`;
    await db.insert(stories).values(storyInsert({ canonicalUrl: url }));
    const before = (await db.execute(sql`select count(*)::int as n from threads`)) as unknown as [
      { n: number },
    ];
    await expect(
      db.transaction(async (tx) => {
        const created = must(
          (
            await tx
              .insert(stories)
              .values(storyInsert({ canonicalUrl: `https://example.com/tx2-${randomUUID()}` }))
              .returning()
          )[0],
        );
        await tx.insert(threads).values({ storyId: created.storyId });
        // Force a failure AFTER the thread insert: duplicate canonical URL.
        await tx.insert(stories).values(storyInsert({ canonicalUrl: url }));
      }),
    ).rejects.toThrow();
    const after = (await db.execute(sql`select count(*)::int as n from threads`)) as unknown as [
      { n: number },
    ];
    expect(after[0].n).toBe(before[0].n); // no orphan thread escaped the rollback

    // The unique shell: a second thread for the same story is rejected.
    const story = must((await db.insert(stories).values(storyInsert()).returning())[0]);
    await db.insert(threads).values({ storyId: story.storyId });
    await expect(db.insert(threads).values({ storyId: story.storyId })).rejects.toThrow();
  });

  it('round-trips claims/evidence and navigates both directions (WS-F.1.2a/2.5a)', async () => {
    const story = must((await db.insert(stories).values(storyInsert()).returning())[0]);
    const claim = must(
      (
        await db
          .insert(claims)
          .values({
            storyId: story.storyId,
            canonicalText: 'The reservoir level fell by 12% in May.',
            normalizedTextHash: randomUUID().replaceAll('-', ''),
            extractionSource: 'system',
            extractionConfidence: 0.8,
          })
          .returning()
      )[0],
    );
    const group = randomUUID();
    await db.insert(evidenceCards).values([
      {
        claimId: claim.claimId,
        submittedBy: submitterId,
        evidenceType: 'supports',
        citationUrlOrRef: 'https://example.com/report',
        relevanceNote: 'Official measurement bulletin.',
        independenceGroupId: group,
      },
      {
        claimId: claim.claimId,
        submittedBy: submitterId,
        evidenceType: 'contradicts',
        citationUrlOrRef: 'https://example.com/other',
        relevanceNote: 'Alternative dataset disagrees.',
        independenceGroupId: group,
      },
    ]);
    // claim → cards.
    const cards = await db.query.evidenceCards.findMany({
      where: (e, { eq }) => eq(e.claimId, claim.claimId),
    });
    expect(cards).toHaveLength(2);
    // card → claim.
    const back = await db.query.claims.findFirst({
      where: (c, { eq }) => eq(c.claimId, must(cards[0]).claimId),
    });
    expect(back?.canonicalText).toContain('reservoir');
    // Shared independence grouping (MERI, §13.6).
    expect(new Set(cards.map((c) => c.independenceGroupId)).size).toBe(1);
    // Cross-story claims: story_id may be null.
    const free = await db
      .insert(claims)
      .values({
        canonicalText: 'A story-less cross-story claim.',
        normalizedTextHash: randomUUID().replaceAll('-', ''),
        extractionSource: 'steward',
      })
      .returning();
    expect(must(free[0]).storyId).toBeNull();
    createdClaimIds.push(must(free[0]).claimId);
    // Out-of-range confidence is rejected at the storage layer.
    await expect(
      db.insert(claims).values({
        canonicalText: 'bad confidence',
        normalizedTextHash: randomUUID().replaceAll('-', ''),
        extractionSource: 'system',
        extractionConfidence: 1.5,
      }),
    ).rejects.toThrow();
  });

  it('enforces source domain uniqueness + syndication pair/self/direction constraints (WS-F.2.1a/2.4)', async () => {
    const domain = `news-${randomUUID().slice(0, 8)}.example`;
    const a = must(
      (await db.insert(sources).values({ name: 'A', canonicalDomain: domain }).returning())[0],
    );
    createdSourceIds.push(a.sourceId);
    await expect(
      db.insert(sources).values({ name: 'A2', canonicalDomain: domain.toUpperCase() }),
    ).rejects.toThrow(); // case-insensitive partial unique
    const b = must(
      (
        await db
          .insert(sources)
          .values({ name: 'B', canonicalDomain: `b-${domain}` })
          .returning()
      )[0],
    );
    createdSourceIds.push(b.sourceId);
    await db.insert(sourceSyndications).values({
      fromSourceId: a.sourceId,
      toSourceId: b.sourceId,
      relationshipType: 'wire',
      establishedBy: 'steward',
      status: 'confirmed',
      evidenceRef: 'integration test',
      confidence: 1,
    });
    // Duplicate directed pair rejected.
    await expect(
      db.insert(sourceSyndications).values({
        fromSourceId: a.sourceId,
        toSourceId: b.sourceId,
        relationshipType: 'republish',
        establishedBy: 'steward',
        status: 'confirmed',
        evidenceRef: 'dup',
        confidence: 1,
      }),
    ).rejects.toThrow();
    // Self-edge rejected; non-canonical direction rejected.
    await expect(
      db.insert(sourceSyndications).values({
        fromSourceId: a.sourceId,
        toSourceId: a.sourceId,
        relationshipType: 'wire',
        establishedBy: 'steward',
        status: 'confirmed',
        evidenceRef: 'self',
        confidence: 1,
      }),
    ).rejects.toThrow();
    await expect(
      db.insert(sourceSyndications).values({
        fromSourceId: b.sourceId,
        toSourceId: a.sourceId,
        direction: 'syndicated_from',
        relationshipType: 'wire',
        establishedBy: 'steward',
        status: 'confirmed',
        evidenceRef: 'dir',
        confidence: 1,
      }),
    ).rejects.toThrow();
  });

  it('stores signatures with the octet-length CHECK and bounded freshness (WS-F.1.3c/1.4g)', async () => {
    const story = must((await db.insert(stories).values(storyInsert()).returning())[0]);
    await db.insert(storySignatures).values({
      storyId: story.storyId,
      minhash: Buffer.alloc(128 * 4),
      shingleK: 5,
      numHashes: 128,
      familyVersion: 1,
      textSource: 'submitted',
    });
    await expect(
      db.insert(storySignatures).values({
        storyId: story.storyId,
        minhash: Buffer.alloc(100), // wrong length for num_hashes = 128
        shingleK: 5,
        numHashes: 128,
        familyVersion: 1,
        textSource: 'submitted',
      }),
    ).rejects.toThrow();
    await db.insert(storyFreshness).values({
      storyId: story.storyId,
      freshnessScore: 0.75,
      topicBaselineMs: 3_600_000,
      featureVersion: 1,
      computedAt: new Date(),
    });
    await expect(
      db
        .insert(storyFreshness)
        .values({
          storyId: story.storyId,
          freshnessScore: 1.5,
          topicBaselineMs: null,
          featureVersion: 1,
          computedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: storyFreshness.storyId,
          set: { freshnessScore: 1.5 },
        }),
    ).rejects.toThrow();
  });

  it('embeddings: unique constraint, HNSW index usage, and correct cosine ordering (WS-F.3.2b/d)', async () => {
    const story = must((await db.insert(stories).values(storyInsert()).returning())[0]);
    const near = must((await db.insert(stories).values(storyInsert()).returning())[0]);
    const far = must((await db.insert(stories).values(storyInsert()).returning())[0]);
    const hidden = must(
      (
        await db
          .insert(stories)
          .values(storyInsert({ hiddenState: 'takedown' }))
          .returning()
      )[0],
    );
    const version = 'v-test-1';
    await db.insert(embeddings).values([
      {
        targetType: 'story',
        targetId: story.storyId,
        modelVersion: version,
        embedding: unitVector(0),
      },
      {
        targetType: 'story',
        targetId: near.storyId,
        modelVersion: version,
        embedding: unitVector(0, 0.1),
      },
      {
        targetType: 'story',
        targetId: far.storyId,
        modelVersion: version,
        embedding: unitVector(5),
      },
      {
        targetType: 'story',
        targetId: hidden.storyId,
        modelVersion: version,
        embedding: unitVector(0, 0.05),
      },
    ]);
    // Duplicate (type, id, version) rejected.
    await expect(
      db.insert(embeddings).values({
        targetType: 'story',
        targetId: story.storyId,
        modelVersion: version,
        embedding: unitVector(1),
      }),
    ).rejects.toThrow();
    // A SECOND model version coexists (the WS-F.3.2f upgrade path).
    await db.insert(embeddings).values({
      targetType: 'story',
      targetId: story.storyId,
      modelVersion: 'v-test-2',
      embedding: unitVector(2),
    });

    const hits = await findSimilarStories(db, story.storyId, {
      threshold: 0.5,
      limit: 10,
      modelVersion: version,
      efSearch: 80,
    });
    // Mathematical check: cos(near, query) ≈ 0.994 (axes 0/1 blend) passes the
    // 0.5 threshold; cos(far, query) = 0 fails it; the HIDDEN story is more
    // similar than `near` but must be excluded by visibility filtering.
    expect(hits.map((h) => h.targetId)).toEqual([near.storyId]);
    expect(must(hits[0]).similarity).toBeGreaterThan(0.95);

    const plan = await client.unsafe(
      `SET LOCAL enable_seqscan = off; EXPLAIN SELECT target_id FROM embeddings ORDER BY embedding <=> '${JSON.stringify(unitVector(0))}'::vector LIMIT 5`,
    );
    expect(JSON.stringify(plan)).toMatch(/embeddings_hnsw_cosine_idx/);
  });

  it('claim/evidence similarity helpers order by cosine and exclude retracted (WS-F.3.2d)', async () => {
    const version = 'v-claims-1';
    const mk = async (text: string, status: 'candidate' | 'retracted' = 'candidate') => {
      const row = must(
        (
          await db
            .insert(claims)
            .values({
              canonicalText: text,
              normalizedTextHash: randomUUID().replaceAll('-', ''),
              extractionSource: 'system',
              claimStatus: status,
            })
            .returning()
        )[0],
      );
      createdClaimIds.push(row.claimId);
      return row;
    };
    const anchor = await mk('Anchor claim.');
    const close = await mk('Close claim.');
    const retracted = await mk('Retracted near claim.', 'retracted');
    await db.insert(embeddings).values([
      {
        targetType: 'claim',
        targetId: anchor.claimId,
        modelVersion: version,
        embedding: unitVector(10),
      },
      {
        targetType: 'claim',
        targetId: close.claimId,
        modelVersion: version,
        embedding: unitVector(10, 0.1),
      },
      {
        targetType: 'claim',
        targetId: retracted.claimId,
        modelVersion: version,
        embedding: unitVector(10, 0.05),
      },
    ]);
    const similar = await findSimilarClaims(db, anchor.claimId, {
      threshold: 0.5,
      limit: 10,
      modelVersion: version,
    });
    expect(similar.map((h) => h.targetId)).toEqual([close.claimId]);

    const card = must(
      (
        await db
          .insert(evidenceCards)
          .values({
            claimId: anchor.claimId,
            submittedBy: submitterId,
            evidenceType: 'supports',
            citationUrlOrRef: 'https://example.com/near-evidence',
            relevanceNote: 'near evidence',
          })
          .returning()
      )[0],
    );
    await db.insert(embeddings).values({
      targetType: 'evidence_card',
      targetId: card.evidenceId,
      modelVersion: version,
      embedding: unitVector(10, 0.2),
    });
    const nearest = await findNearestEvidenceCards(db, anchor.claimId, {
      limit: 5,
      modelVersion: version,
    });
    expect(nearest.map((h) => h.targetId)).toEqual([card.evidenceId]);
  });

  it('findSimilarInterpretations surfaces DIVERGENT pairs, lowest similarity first (SCOI)', async () => {
    // Interpretation embeddings exist without the WS-G entity (the documented
    // seam): three vectors — two aligned, one orthogonal.
    const version = 'v-interp-1';
    const ids = [randomUUID(), randomUUID(), randomUUID()].sort();
    const vectors = [unitVector(20), unitVector(20, 0.05), unitVector(40)];
    for (let i = 0; i < ids.length; i += 1) {
      await db.insert(embeddings).values({
        targetType: 'community_interpretation',
        targetId: ids[i] as string,
        modelVersion: version,
        embedding: vectors[i] as number[],
      });
    }
    const pairs = await findSimilarInterpretations(db, ids, {
      divergenceThreshold: 0.5,
      limit: 10,
      modelVersion: version,
    });
    // The two aligned interpretations (cos ≈ 1) are NOT divergent; both pairs
    // involving the orthogonal one (cos = 0) are, ordered ascending.
    expect(pairs).toHaveLength(2);
    for (const pair of pairs) {
      expect(pair.similarity).toBeLessThanOrEqual(0.5);
    }
    expect((pairs[0]?.similarity as number) <= (pairs[1]?.similarity as number)).toBe(true);
    expect(
      await findSimilarInterpretations(db, [ids[0] as string], {
        divergenceThreshold: 0.5,
        limit: 10,
        modelVersion: version,
      }),
    ).toEqual([]);
    await db.execute(sql`delete from embeddings where model_version = ${version}`);
  });
});
