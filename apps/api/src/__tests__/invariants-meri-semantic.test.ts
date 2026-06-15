// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-O.4.5 — MERI SEMANTIC independence. A hard paraphrase (low lexical overlap,
// high embedding cosine) that beats the MinHash near-duplicate threshold is
// still grouped via the embedding-cosine union, so exposure can't be inflated by
// paraphrasing harder. The signal degrades gracefully when embeddings are
// absent. (Its real-world STRENGTH depends on the deployed embedding provider —
// the default is lexical; a semantic EMBEDDING_URL provider realizes the
// semantic benefit — but the wiring is provider-agnostic and proven here with a
// controlled embedding.)

import { beforeEach, describe, expect, it } from 'vitest';
import { assembleMeriCandidates } from '../invariants/data.js';
import {
  freshInvariantServices,
  type InvariantServicesFixture,
  seedStory,
} from './invariant-test-helpers.js';

let fixture: InvariantServicesFixture;
beforeEach(() => {
  fixture = freshInvariantServices();
});

/** A 384-dim unit vector pointing along one axis (the table dimension). */
function unitVector(axis: number): Float32Array {
  const v = new Float32Array(384);
  v[axis] = 1;
  return v;
}

async function seedEmbedding(storyId: string, axis: number): Promise<void> {
  await fixture.ingestion.embeddings.upsert({
    targetType: 'story',
    targetId: storyId,
    modelVersion: fixture.ingestion.embeddingProvider.modelVersion,
    embedding: unitVector(axis),
  });
}

const groupOf = async (storyId: string): Promise<string | null> => {
  const candidates = await assembleMeriCandidates(fixture.ingestion, null, 100, 0.7, 0.85);
  return candidates.find((c) => c.id === storyId)?.nearDuplicateGroupId ?? null;
};

describe('MERI semantic independence (WS-O.4.5)', () => {
  it('groups a hard paraphrase via embedding cosine that lexical MinHash misses', async () => {
    // Distinct surface text (no MinHash collision) ...
    const a = await seedStory(fixture, {
      title: 'Aquifer levels stable, says the regional water board',
    });
    const b = await seedStory(fixture, {
      title: 'Groundwater unchanged per the district hydrology authority',
    });
    // ... but identical embedding direction (cosine 1.0 ≥ the 0.85 threshold).
    await seedEmbedding(a.storyId, 0);
    await seedEmbedding(b.storyId, 0);
    const candidates = await assembleMeriCandidates(fixture.ingestion, null, 100, 0.7, 0.85);
    const ga = candidates.find((c) => c.id === a.storyId)?.nearDuplicateGroupId ?? null;
    const gb = candidates.find((c) => c.id === b.storyId)?.nearDuplicateGroupId ?? null;
    expect(ga).not.toBeNull();
    expect(ga).toBe(gb); // the paraphrase is bounded into one exposure group
  });

  it('does NOT group semantically distinct stories (orthogonal embeddings)', async () => {
    const a = await seedStory(fixture, { title: 'A regional water report' });
    const b = await seedStory(fixture, { title: 'A municipal transit budget' });
    await seedEmbedding(a.storyId, 0);
    await seedEmbedding(b.storyId, 1); // orthogonal → cosine 0 < threshold
    expect(await groupOf(a.storyId)).toBeNull();
  });

  it('falls back to MinHash-only when embeddings are absent (graceful)', async () => {
    const a = await seedStory(fixture, { title: 'No-embedding story alpha' });
    await seedStory(fixture, { title: 'No-embedding story beta' });
    // No embeddings seeded → findSimilar yields nothing → no semantic union,
    // and the distinct text has no MinHash collision → no group at all.
    expect(await groupOf(a.storyId)).toBeNull();
  });
});
