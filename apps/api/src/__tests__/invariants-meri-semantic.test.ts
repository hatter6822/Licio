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
  const candidates = await assembleMeriCandidates(fixture.ingestion, null, null, 100, 0.7, 0.85);
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
    const candidates = await assembleMeriCandidates(fixture.ingestion, null, null, 100, 0.7, 0.85);
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

  // The union-find behind this grouping uses path compression and a
  // tallied-once member count.  A CLUSTER is exactly the input shape that
  // distinguishes a correct implementation from a subtly wrong one: it is the
  // case that builds a multi-hop parent chain, so a compression bug would
  // re-root part of the cluster and split it into two groups (or drop a member
  // below the ≥2 threshold and yield null).
  it('keeps a whole multi-member cluster in ONE group', async () => {
    const seeded = [];
    for (const title of [
      'Reservoir capacity holds near seasonal norms',
      'Water storage close to the usual level for the season',
      'District reports reservoirs at typical seasonal capacity',
      'Seasonal norms met by regional water storage figures',
      'Regional storage figures match the seasonal expectation',
    ]) {
      seeded.push(await seedStory(fixture, { title }));
    }
    // One shared embedding direction ⇒ every pair unions, in seeding order —
    // the chain the compression must collapse without moving the root.
    for (const story of seeded) await seedEmbedding(story.storyId, 3);

    const candidates = await assembleMeriCandidates(fixture.ingestion, null, null, 100, 0.7, 0.85);
    const groups = seeded.map(
      (s) => candidates.find((c) => c.id === s.storyId)?.nearDuplicateGroupId ?? null,
    );
    expect(groups.every((g) => g !== null)).toBe(true);
    // ALL five share one group id — not two roots, not a dropped member.
    expect(new Set(groups).size).toBe(1);
  });

  // The counts are tallied once, after every union settles.  A story outside the
  // cluster must still read as ungrouped — the tally must not leak a neighbour's
  // membership into a singleton's root.
  it('leaves a singleton ungrouped alongside a cluster', async () => {
    const clustered = [
      await seedStory(fixture, { title: 'Ferry timetable revised for the winter season' }),
      await seedStory(fixture, { title: 'Winter ferry schedule updated by the operator' }),
    ];
    for (const story of clustered) await seedEmbedding(story.storyId, 4);
    const lone = await seedStory(fixture, { title: 'Library extends weekend opening hours' });
    await seedEmbedding(lone.storyId, 5); // orthogonal to the cluster

    const candidates = await assembleMeriCandidates(fixture.ingestion, null, null, 100, 0.7, 0.85);
    const groupFor = (id: string): string | null =>
      candidates.find((c) => c.id === id)?.nearDuplicateGroupId ?? null;
    const first = clustered[0];
    const second = clustered[1];
    expect(first && second).toBeTruthy();
    if (!first || !second) return;
    expect(groupFor(first.storyId)).not.toBeNull();
    expect(groupFor(first.storyId)).toBe(groupFor(second.storyId));
    expect(groupFor(lone.storyId)).toBeNull();
  });
});
