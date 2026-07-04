// SPDX-License-Identifier: AGPL-3.0-or-later

import { lshBandHashes, minhashSignature } from '@licio/invariants';
import { TOPIC_KEYWORDS, topicIdForSlug } from '@licio/shared';
import { describe, expect, it } from 'vitest';
import {
  DOMAIN_IDS,
  generateCommentBody,
  generateEvidence,
  generateRepost,
  generateStory,
  isSimulatedUrl,
  type StoryKind,
} from '../content.js';
import { createPrng } from '../prng.js';
import { req } from './sim-test-util.js';

const pickDomain = (index: number) => req(DOMAIN_IDS[index % DOMAIN_IDS.length]);

const KINDS: readonly StoryKind[] = ['link', 'original_brief', 'question', 'local_update'];

describe('simulator content generation', () => {
  it('is deterministic per seed + serial', () => {
    const a = generateStory('health', 'link', 7, createPrng('c'));
    const b = generateStory('health', 'link', 7, createPrng('c'));
    expect(a).toEqual(b);
  });

  it('embeds the serial in every link URL so URLs never collide by accident', () => {
    const urls = new Set<string>();
    const prng = createPrng('urls');
    for (let serial = 0; serial < 200; serial += 1) {
      const domain = pickDomain(serial);
      const story = generateStory(domain, 'link', serial, prng);
      expect(story.url).not.toBeNull();
      expect(story.url).toContain(String(serial));
      urls.add(req(story.url));
    }
    expect(urls.size).toBe(200);
  });

  it('link URLs resolve as simulated hosts (isSimulatedUrl) so the dev fetcher serves them', () => {
    const prng = createPrng('hosts');
    for (const domain of DOMAIN_IDS) {
      const story = generateStory(domain, 'link', 1, prng);
      expect(isSimulatedUrl(req(story.url))).toBe(true);
    }
    expect(isSimulatedUrl('https://example.com/x')).toBe(false);
    expect(isSimulatedUrl('not a url')).toBe(false);
  });

  it('weaves topic keywords so the WS-K classifier can promote the proposed topic', () => {
    const prng = createPrng('kw');
    for (const domain of DOMAIN_IDS) {
      const story = generateStory(domain, 'original_brief', 1, prng);
      const primaryId = topicIdForSlug(req(story.topicSlugs[0]));
      const keywords = TOPIC_KEYWORDS.get(primaryId) ?? [];
      const haystack = `${story.title} ${story.body}`.toLowerCase();
      const matches = keywords.filter((kw) => haystack.includes(kw));
      // At least one catalog keyword present so classification can occur.
      expect(matches.length).toBeGreaterThan(0);
    }
  });

  it('produces topic ids that are all real catalog ids', () => {
    const prng = createPrng('topics');
    for (const domain of DOMAIN_IDS) {
      for (const kind of KINDS) {
        const story = generateStory(domain, kind, 3, prng);
        expect(story.topicIds.length).toBeGreaterThanOrEqual(1);
        expect(story.topicIds.length).toBeLessThanOrEqual(5);
        for (const [i, id] of story.topicIds.entries()) {
          expect(id).toBe(topicIdForSlug(req(story.topicSlugs[i])));
        }
      }
    }
  });

  it('generates comment bodies substantial enough to avoid the low-info classifier', () => {
    const prng = createPrng('comments');
    for (const flavor of [
      'root_question',
      'root_observation',
      'reply_answer',
      'reply_followup',
    ] as const) {
      const body = generateCommentBody(flavor, 'science', prng);
      expect(body.length).toBeGreaterThan(60);
      expect(body).not.toContain('{object}');
      expect(body).not.toContain('{period}');
    }
  });

  it('distinct link stories do not collide under MinHash/LSH (except intentional reposts)', () => {
    // The submission dedup uses LSH band-hash collisions on title+body. Generate
    // a spread of distinct stories and assert their band signatures are diverse.
    const prng = createPrng('minhash');
    const bandSets: string[] = [];
    for (let serial = 0; serial < 30; serial += 1) {
      const domain = pickDomain(serial);
      const story = generateStory(domain, 'link', serial, prng);
      const sig = minhashSignature(`${story.title} ${story.body}`);
      bandSets.push(lshBandHashes(sig).join(','));
    }
    // No two distinct generated stories share an identical full band vector.
    expect(new Set(bandSets).size).toBe(bandSets.length);
  });

  it('an intentional repost DOES collide with the original under MinHash (the MERI demo)', () => {
    const prng = createPrng('repost');
    const original = generateStory('climate', 'link', 1, prng);
    const repost = generateRepost(original.title, original.body, 'climate', 2, prng);
    // Same title → the near-duplicate detector should see high similarity: at
    // least one shared LSH band (the dedup trigger).
    const origBands = lshBandHashes(minhashSignature(`${original.title} ${original.body}`));
    const repostBands = lshBandHashes(minhashSignature(`${repost.title} ${repost.body}`));
    const shared = origBands.some((band, i) => band === repostBands[i]);
    expect(shared).toBe(true);
    expect(repost.url).not.toBe(original.url);
  });

  it('evidence generation returns a body and a fresh citation URL', () => {
    const prng = createPrng('evidence');
    const a = generateEvidence('health', 1, prng);
    const b = generateEvidence('health', 2, prng);
    expect(a.body.length).toBeGreaterThan(20);
    expect(a.citationUrl).not.toBe(b.citationUrl);
    expect(isSimulatedUrl(a.citationUrl)).toBe(true);
  });
});
