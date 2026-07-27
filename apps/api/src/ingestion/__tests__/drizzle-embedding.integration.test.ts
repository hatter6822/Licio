// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Gated integration test (DATABASE_URL) for the pgvector embedding store —
// specifically the `findSimilar` ANN path the WS-O.4.5 MERI semantic
// near-duplicate union depends on. Proves, against live pgvector, that a
// near-identical embedding is returned above the cosine threshold and an
// orthogonal one is not (so the MERI grouping union can collapse a hard
// paraphrase in production, not only against the in-memory exact scan).

import { randomUUID } from 'node:crypto';
import { createDbClient, EMBEDDING_DIMENSION, migrationsFolder } from '@licio/db';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleEmbeddingStore } from '../drizzle-ingestion-stores.js';

const DB_URL = process.env['DATABASE_URL'];

/** A 384-dim unit vector along one axis (cosine 1 with itself, 0 with another). */
function unitVector(axis: number): Float32Array {
  const v = new Float32Array(EMBEDDING_DIMENSION);
  v[axis] = 1;
  return v;
}

describe.skipIf(!DB_URL)('DrizzleEmbeddingStore findSimilar (live pgvector)', () => {
  let db: ReturnType<typeof createDbClient>;

  beforeAll(async () => {
    db = createDbClient(DB_URL as string, { onNotice: 'discard' });
    await migrate(db, { migrationsFolder: migrationsFolder() });
  });

  afterAll(async () => {
    await db.$client.end();
  });

  it('returns a near-identical embedding above threshold and excludes an orthogonal one', async () => {
    const store = new DrizzleEmbeddingStore(db);
    const model = `meri-semantic-test-${randomUUID().slice(0, 8)}`;
    const a = randomUUID();
    const paraphrase = randomUUID();
    const orthogonal = randomUUID();
    await store.upsert({
      targetType: 'story',
      targetId: a,
      modelVersion: model,
      embedding: unitVector(0),
    });
    await store.upsert({
      targetType: 'story',
      targetId: paraphrase,
      modelVersion: model,
      embedding: unitVector(0), // cosine 1.0 with `a`
    });
    await store.upsert({
      targetType: 'story',
      targetId: orthogonal,
      modelVersion: model,
      embedding: unitVector(1), // cosine 0 with `a`
    });

    // The MERI union queries findSimilar(story, a, model, threshold, limit).
    const similar = await store.findSimilar('story', a, model, 0.85, 50);
    const ids = similar.map((s) => s.targetId);
    expect(ids).toContain(paraphrase); // grouped — exposure can't inflate
    expect(ids).not.toContain(orthogonal); // genuinely distinct — not grouped
    expect(ids).not.toContain(a); // the query anchor is excluded
  });
});
