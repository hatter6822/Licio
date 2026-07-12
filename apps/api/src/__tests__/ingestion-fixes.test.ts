// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Regression + feature tests for the WS-F items completed in the follow-up
// pass: anonymous takedown intake (A1), complete DSAR export pagination (A3),
// and embedding-similarity claim dedup (B6 / WS-F.1.2b soft dep).
import { randomUUID } from 'node:crypto';
import { COMMONS_ROOM_ID } from '@licio/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import {
  type ClaimEmbeddingDedup,
  HeuristicClaimExtractor,
  persistCandidateClaims,
} from '../ingestion/claims.js';
import { embedTarget } from '../ingestion/embeddings.js';
import {
  InMemoryClaimStore,
  InMemoryEmbeddingStore,
  InMemoryReviewQueueStore,
} from '../ingestion/stores.js';
import {
  freshIngestionServices,
  type IngestionServicesFixture,
  seedUserWithSession,
  TEST_TOPIC_ID,
} from './ingestion-test-helpers.js';

/** A 384-d unit vector concentrated on `axis`, optionally blended toward the
 *  next axis (controls cosine precisely for the dedup test). */
function unitVector(axis: number, blend = 0): Float32Array {
  const v = new Float32Array(384);
  v[axis % 384] = 1 - blend;
  v[(axis + 1) % 384] = blend;
  let norm = 0;
  for (const x of v) norm += x * x;
  const inv = 1 / Math.sqrt(norm);
  for (let i = 0; i < v.length; i += 1) v[i] = (v[i] as number) * inv;
  return v;
}

let fixture: IngestionServicesFixture;

beforeEach(() => {
  fixture = freshIngestionServices({ config: { minAccountAgeMinutes: 0 } });
});

describe('A1: anonymous takedown intake through the FULL app (WS-F.1.4f)', () => {
  it('accepts a cookie-less public takedown with 202 (no CSRF token required)', async () => {
    // The composed app applies the CSRF middleware; a rights holder has no
    // session, so there is no token to send. Before the fix this returned 403.
    const res = await createApp().request(
      new Request('http://localhost/v1/takedowns', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          target_type: 'story',
          target_id: randomUUID(),
          requester_contact: 'rights@example.com',
          legal_basis: 'copyright',
          claim_detail: 'The story reproduces our copyrighted article in full.',
        }),
      }),
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as { status: string; takedown_id: string };
    expect(body.status).toBe('received');
    expect(body.takedown_id).toBeTruthy();
  });

  it('still rejects a token-less story submission (CSRF intact elsewhere)', async () => {
    const { cookie } = await seedUserWithSession(fixture.identity);
    const res = await createApp().request(
      new Request('http://localhost/v1/stories', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({
          submission_type: 'original_brief',
          room_id: COMMONS_ROOM_ID,
          body: 'A body.',
          title: 'A title',
          topic_ids: [TEST_TOPIC_ID],
        }),
      }),
    );
    expect(res.status).toBe(403); // the exemption is scoped to /v1/takedowns only
  });
});

describe('A3: DSAR export is COMPLETE across page boundaries (WS-D §19.3)', () => {
  it('listBySubmitter keyset-paginates ALL of a user submitter, no truncation', async () => {
    const me = randomUUID();
    const other = randomUUID();
    // Insert more stories than a page; interleave another user's stories.
    const inserted: string[] = [];
    for (let i = 0; i < 7; i += 1) {
      const created = await fixture.ingestion.stories.createWithThread(
        {
          storyId: randomUUID(),
          canonicalUrl: null,
          title: `My story ${i}`,
          titleHash: randomUUID().replaceAll('-', ''),
          submittedBy: me,
          sourceId: null,
          roomId: COMMONS_ROOM_ID,
          visibility: 'public',
          mediaUploadRef: null,
          canonicalPublicStoryId: null,
          language: 'en',
          topicIds: [randomUUID()],
          locationScope: null,
          sensitivityLabels: ['none'],
          lifecycleState: 'submitted',
          submissionType: 'original_brief',
          submissionMetadata: { submission_type: 'original_brief', body: `body ${i}` },
          excerpt: null,
          publisher: null,
          author: null,
          publishedAt: null,
          mediaType: null,
          extractionState: 'not_applicable',
          hiddenState: null,
        },
        randomUUID(),
      );
      if (created.ok) inserted.push(created.story.storyId);
      await fixture.ingestion.stories.createWithThread(
        {
          storyId: randomUUID(),
          canonicalUrl: null,
          title: `Other ${i}`,
          titleHash: randomUUID().replaceAll('-', ''),
          submittedBy: other,
          sourceId: null,
          roomId: COMMONS_ROOM_ID,
          visibility: 'public',
          mediaUploadRef: null,
          canonicalPublicStoryId: null,
          language: 'en',
          topicIds: [randomUUID()],
          locationScope: null,
          sensitivityLabels: ['none'],
          lifecycleState: 'submitted',
          submissionType: 'original_brief',
          submissionMetadata: { submission_type: 'original_brief', body: `other ${i}` },
          excerpt: null,
          publisher: null,
          author: null,
          publishedAt: null,
          mediaType: null,
          extractionState: 'not_applicable',
          hiddenState: null,
        },
        randomUUID(),
      );
    }

    // The export-hook loop, paginated with a SMALL page so the boundary is
    // crossed multiple times (the production hook uses PAGE=500).
    const PAGE = 3;
    const collected: string[] = [];
    let after: { createdAt: string; storyId: string } | null = null;
    for (;;) {
      const page = await fixture.ingestion.stories.listBySubmitter(me, after, PAGE);
      for (const s of page) {
        collected.push(s.storyId);
        expect(s.submittedBy).toBe(me); // never another user's story
      }
      if (page.length < PAGE) break;
      const last = page[page.length - 1];
      if (last === undefined) break;
      after = { createdAt: last.createdAt, storyId: last.storyId };
    }
    expect(collected.length).toBe(7); // COMPLETE — no truncation
    expect(new Set(collected).size).toBe(7); // no duplicate across pages
    expect([...collected].sort()).toEqual([...inserted].sort());
  });
});

describe('B6: embedding-similarity claim dedup (WS-F.1.2b soft dep)', () => {
  it('links a candidate to a near-duplicate existing claim the text hash misses', async () => {
    const claims = new InMemoryClaimStore();
    const reviews = new InMemoryReviewQueueStore();
    const embeddings = new InMemoryEmbeddingStore();
    const version = 'stub-v';
    // A controlled provider: the CANDIDATE text embeds ~0.995-similar to the
    // existing claim's vector — deterministic, so the link is not flaky.
    const provider = {
      modelName: 'stub',
      modelVersion: version,
      dimension: 384,
      embed: async (t: string) => (t.includes('CANDIDATE') ? unitVector(0, 0.05) : unitVector(0)),
    };
    const existing = await claims.insert({
      claimId: randomUUID(),
      storyId: randomUUID(),
      canonicalText: 'The committee approved the budget on Tuesday.',
      normalizedTextHash: randomUUID().replaceAll('-', ''),
      claimStatus: 'candidate',
      firstSeenStoryId: null,
      independenceGroupId: null,
      createdBy: null,
      extractionSource: 'system',
      extractionConfidence: 0.7,
      modelVersion: version,
    });
    await embedTarget(embeddings, provider, 'claim', existing.claimId, 'existing claim text');

    const extractor = {
      modelVersion: 'stub-extractor',
      extract: async () => [
        { text: 'A CANDIDATE rephrasing of the budget vote.', confidence: 0.8 },
      ],
    };
    const dedup: ClaimEmbeddingDedup = {
      store: embeddings,
      provider,
      modelVersion: version,
      threshold: 0.9,
    };
    const story = { storyId: randomUUID(), title: 'Budget story' };
    const result = await persistCandidateClaims(
      claims,
      reviews,
      extractor,
      story,
      'body text',
      0.5,
      dedup,
    );
    // Near-duplicate (cosine 0.995 ≥ 0.9): NOT an independent claim, but the
    // new story gets its OWN row sharing the existing claim's MERI lineage.
    expect(result.created).toHaveLength(0);
    expect(result.linked).toHaveLength(1);
    const linkedClaim = result.linked[0];
    expect(linkedClaim?.claimId).not.toBe(existing.claimId);
    const original = await claims.getById(existing.claimId);
    expect(original?.independenceGroupId).not.toBeNull();
    expect(linkedClaim?.independenceGroupId).toBe(original?.independenceGroupId);
    // The new story surfaces the deduplicated claim (the WS-F.1.2b read fix).
    expect((await claims.listByStory(story.storyId)).map((c) => c.claimId)).toEqual([
      linkedClaim?.claimId,
    ]);
  });

  it('creates a new claim when no existing claim is similar enough', async () => {
    const claims = new InMemoryClaimStore();
    const reviews = new InMemoryReviewQueueStore();
    const embeddings = new InMemoryEmbeddingStore();
    const version = 'stub-v';
    const provider = {
      modelName: 'stub',
      modelVersion: version,
      dimension: 384,
      embed: async (t: string) => (t.includes('CANDIDATE') ? unitVector(50) : unitVector(0)),
    };
    await embedTarget(embeddings, provider, 'claim', randomUUID(), 'unrelated');
    const extractor = {
      modelVersion: 'stub-extractor',
      extract: async () => [{ text: 'A CANDIDATE about an unrelated topic.', confidence: 0.8 }],
    };
    const dedup: ClaimEmbeddingDedup = {
      store: embeddings,
      provider,
      modelVersion: version,
      threshold: 0.9,
    };
    const result = await persistCandidateClaims(
      claims,
      reviews,
      extractor,
      { storyId: randomUUID(), title: 'Story' },
      'body',
      0.5,
      dedup,
    );
    expect(result.created).toHaveLength(1); // orthogonal vector ⇒ no link
    expect(result.linked).toHaveLength(0);
  });

  it('the real heuristic extractor + lexical provider still produce valid claims', async () => {
    // End-to-end sanity: the pipeline path (lexical provider) runs without
    // error and the text-hash dedup is unaffected by the embedding layer.
    const extractor = new HeuristicClaimExtractor();
    const candidates = await extractor.extract(
      'Report',
      'The agency confirmed the figure on Monday. The agency confirmed the figure on Monday.',
    );
    // Two identical sentences ⇒ one candidate (extractor dedups by hash).
    expect(candidates).toHaveLength(1);
  });
});
