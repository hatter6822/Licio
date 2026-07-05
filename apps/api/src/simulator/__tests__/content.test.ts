// SPDX-License-Identifier: AGPL-3.0-or-later

import { minhashSignature } from '@licio/invariants';
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
  simulatedArticleBody,
  uniqueSubject,
} from '../content.js';
import { createPrng } from '../prng.js';
import { req } from './sim-test-util.js';

/** Estimated Jaccard similarity between two MinHash signatures — the fraction of
 *  matching values, the metric the WS-F near-duplicate detector thresholds at
 *  0.7. Takes precomputed signatures so a pairwise sweep signs each text ONCE. */
function jaccardOf(x: Uint32Array, y: Uint32Array): number {
  let match = 0;
  for (let i = 0; i < x.length; i += 1) if (x[i] === y[i]) match += 1;
  return match / x.length;
}

/** Estimated Jaccard between two texts (signs both once). */
function jaccard(a: string, b: string): number {
  return jaccardOf(minhashSignature(a), minhashSignature(b));
}

/** The largest pairwise estimated Jaccard across a set of texts. Signs each text
 *  exactly once (O(n) signatures + O(n²) cheap Hamming compares), so the sweep
 *  stays fast even under coverage instrumentation. */
function maxPairwiseJaccard(texts: readonly string[]): number {
  const sigs = texts.map((t) => minhashSignature(t));
  let max = 0;
  for (let i = 0; i < sigs.length; i += 1) {
    for (let j = i + 1; j < sigs.length; j += 1) {
      max = Math.max(max, jaccardOf(req(sigs[i]), req(sigs[j])));
    }
  }
  return max;
}

/** What the WS-F pipeline signs for a LINK: story.title + the FETCHED article. */
const fetchedText = (title: string, url: string): string =>
  `${title} ${simulatedArticleBody(new URL(url))}`;
/** What it signs for an inline-content story: title + body. */
const submitted = (title: string, body: string): string => `${title} ${body}`;

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
      const story = generateStory(pickDomain(serial), 'link', serial, prng);
      expect(story.url).not.toBeNull();
      expect(story.url).toContain(String(serial));
      urls.add(req(story.url));
    }
    expect(urls.size).toBe(200);
  });

  it('link URLs resolve as simulated hosts so the dev fetcher serves them', () => {
    const prng = createPrng('hosts');
    for (const domain of DOMAIN_IDS) {
      const story = generateStory(domain, 'link', 1, prng);
      expect(isSimulatedUrl(req(story.url))).toBe(true);
    }
    expect(isSimulatedUrl('https://example.com/x')).toBe(false);
    expect(isSimulatedUrl('not a url')).toBe(false);
  });

  it('uniqueSubject yields distinct subjects for distinct serials (576 combinations)', () => {
    const seen = new Set<string>();
    for (let s = 0; s < 576; s += 1) seen.add(uniqueSubject(s));
    expect(seen.size).toBe(576);
    for (let s = 0; s < 100; s += 1) {
      const [qA, ...restA] = uniqueSubject(s).split(' ');
      const [qB, ...restB] = uniqueSubject(s + 1).split(' ');
      expect(qA).not.toBe(qB);
      expect(restA.join(' ')).not.toBe(restB.join(' '));
    }
  });

  it('weaves topic keywords so the WS-K classifier can promote the proposed topic', () => {
    const prng = createPrng('kw');
    for (const domain of DOMAIN_IDS) {
      const story = generateStory(domain, 'original_brief', 1, prng);
      const primaryId = topicIdForSlug(req(story.topicSlugs[0]));
      const keywords = TOPIC_KEYWORDS.get(primaryId) ?? [];
      const haystack = `${story.title} ${story.body}`.toLowerCase();
      expect(keywords.filter((kw) => haystack.includes(kw)).length).toBeGreaterThan(0);
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

  it('distinct link stories stay below 0.7 under MinHash of the FETCHED article', () => {
    // A link is signed for near-dup over its fetched article; distinct stories
    // must produce distinct fetched documents (even in the same domain) so
    // unrelated links are never grouped as duplicates.
    const prng = createPrng('links');
    const texts: string[] = [];
    for (let serial = 0; serial < 24; serial += 1) {
      const story = generateStory('science', 'link', serial, prng);
      texts.push(fetchedText(story.title, req(story.url)));
    }
    expect(maxPairwiseJaccard(texts)).toBeLessThan(0.7);
  });

  it('a link repost is a verbatim twin of its original under the FETCHED article', () => {
    // The repost reuses the original title, and its URL recovers the same title,
    // so the fetched article is identical (Jaccard 1.0) — the MERI duplicate
    // demo — while an unrelated link in the same domain stays below the threshold.
    const prng = createPrng('repost');
    const original = generateStory('climate', 'link', 1, prng);
    const repost = generateRepost(original.title, original.body, 'climate', 2, prng);
    const other = generateStory('climate', 'link', 3, prng);
    expect(repost.kind).toBe('link');
    expect(repost.url).not.toBe(original.url);
    expect(
      jaccard(
        fetchedText(original.title, req(original.url)),
        fetchedText(repost.title, req(repost.url)),
      ),
    ).toBe(1);
    expect(
      jaccard(
        fetchedText(original.title, req(original.url)),
        fetchedText(other.title, req(other.url)),
      ),
    ).toBeLessThan(0.7);
  });

  it('distinct inline-content stories stay below 0.7 under their submitted text', () => {
    const prng = createPrng('briefs');
    const texts: string[] = [];
    for (let serial = 0; serial < 40; serial += 1) {
      const story = generateStory('health', 'original_brief', serial, prng);
      texts.push(submitted(story.title, story.body));
    }
    expect(maxPairwiseJaccard(texts)).toBeLessThan(0.7);
  });

  it('distinct local_update stories stay below 0.7 under their SIGNED text (title + disclosure)', () => {
    // WS-F signs `${title} ${source_or_experience_disclosure}` for a local_update
    // (submissionBodyText reads ONLY the disclosure — the request carries no
    // `body`), so the generator packs the diverse per-story body into the
    // disclosure. A fixed disclosure would collide every same-template update.
    const prng = createPrng('local');
    const texts: string[] = [];
    for (let serial = 0; serial < 40; serial += 1) {
      const story = generateStory('health', 'local_update', serial, prng);
      texts.push(`${story.title} ${req(story.disclosure)}`);
    }
    expect(maxPairwiseJaccard(texts)).toBeLessThan(0.7);
  });

  it('evidence generation returns a body and a fresh citation reference', () => {
    const prng = createPrng('evidence');
    const a = generateEvidence('health', 1, prng);
    const b = generateEvidence('health', 2, prng);
    expect(a.body.length).toBeGreaterThan(20);
    expect(a.citationUrl).not.toBe(b.citationUrl);
    expect(isSimulatedUrl(a.citationUrl)).toBe(true);
  });
});
