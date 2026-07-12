// SPDX-License-Identifier: AGPL-3.0-or-later

import { minhashSignature } from '@licio/invariants';
import { TOPIC_KEYWORDS, topicIdForSlug } from '@licio/shared';
import { describe, expect, it } from 'vitest';
import {
  DOMAIN_IDS,
  generateCommentBody,
  generateCorrection,
  generateEvidence,
  generateProblemComment,
  generateRebuttal,
  generateReinforcement,
  generateRepost,
  generateStory,
  isSimulatedUrl,
  OVERRIDE_REASONS,
  pickDebateMarker,
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

const KINDS: readonly StoryKind[] = ['link', 'original_brief'];

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

  it('a MIXED link + brief pool stays below 0.7 across both signing surfaces', () => {
    // The retired question/local_update kinds fold into original_brief, so the
    // near-dup surface is exactly the two live signing texts — the FETCHED
    // article for a link, the submitted title+body for a brief. Both draw from
    // the shared sentence pool, so the cross-kind pairs must stay distinct too
    // (a link's article must never read as a near-duplicate of a brief).
    const prng = createPrng('mixed');
    const texts: string[] = [];
    for (let serial = 0; serial < 20; serial += 1) {
      const link = generateStory('health', 'link', serial, prng);
      texts.push(fetchedText(link.title, req(link.url)));
    }
    for (let serial = 20; serial < 40; serial += 1) {
      const brief = generateStory('health', 'original_brief', serial, prng);
      texts.push(submitted(brief.title, brief.body));
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

describe('WS-T correction + rebuttal generators', () => {
  it('generateCorrection: schema-conformant body with 1–4 distinct simulated sources', async () => {
    const { correctionCreateSchema } = await import('@licio/shared');
    const counts = new Set<number>();
    for (let i = 0; i < 30; i += 1) {
      const prng = createPrng(`corr-${i}`);
      const correction = generateCorrection('health', i, prng);
      counts.add(correction.citationUrls.length);
      expect(correction.body.length).toBeGreaterThan(40);
      expect(correction.body.length).toBeLessThanOrEqual(2_000);
      expect(correction.citationUrls.length).toBeGreaterThanOrEqual(1);
      expect(correction.citationUrls.length).toBeLessThanOrEqual(4);
      expect(new Set(correction.citationUrls).size).toBe(correction.citationUrls.length);
      // Distinct REGISTRABLE DOMAINS, not just distinct URLs — the adjudicator's
      // independence feature counts domains, so an advertised N-source challenge
      // must actually provide N independent sources (every bank carries ≥4
      // outlets so even the heaviest pick never wraps).
      const hosts = correction.citationUrls.map((url) => new URL(url).hostname);
      expect(new Set(hosts).size).toBe(hosts.length);
      for (const url of correction.citationUrls) expect(isSimulatedUrl(url)).toBe(true);
      // The exact wire shape the runtime submits parses through the REAL schema.
      const parsed = correctionCreateSchema.safeParse({
        type: 'correction',
        thread_id: '5f5ed000-0000-4000-8000-000000000001',
        client_draft_id: '5f5ed000-0000-4000-8000-000000000002',
        body: correction.body,
        citations: correction.citationUrls.map((url) => ({ url })),
        target_story_id: '5f5ed000-0000-4000-8000-000000000003',
      });
      expect(parsed.success).toBe(true);
    }
    // Weak (1-source) and strong (≥3-source) challenges both occur.
    expect(counts.has(1)).toBe(true);
    expect([...counts].some((n) => n >= 3)).toBe(true);
  });

  it('a FOUR-source correction carries four independent registrable domains (no outlet wrap)', () => {
    // Deterministic seeds: sweep until the weighted pick lands on 4, across
    // every domain bank, and assert the hosts are genuinely distinct.
    for (const domain of DOMAIN_IDS) {
      let found = false;
      for (let i = 0; i < 200 && !found; i += 1) {
        const correction = generateCorrection(domain, i, createPrng(`four-${domain}-${i}`));
        if (correction.citationUrls.length !== 4) continue;
        found = true;
        const hosts = correction.citationUrls.map((url) => new URL(url).hostname);
        expect(new Set(hosts).size).toBe(4);
      }
      expect(found).toBe(true);
    }
  });

  it('generateRebuttal: 1–3 simulated sources (a POSTED position always meets the schema minimum)', () => {
    const seen = new Set<number>();
    for (let i = 0; i < 60; i += 1) {
      const prng = createPrng(`reb-${i}`);
      const rebuttal = generateRebuttal('climate', i, prng);
      expect(rebuttal.body.length).toBeGreaterThan(40);
      // The real debatePositionUpdateSchema requires ≥1 citation — a
      // zero-source position is an input no user can submit; the empty-handed
      // incumbent is modelled by the engine SKIPPING the post (a forfeit).
      expect(rebuttal.citationUrls.length).toBeGreaterThanOrEqual(1);
      expect(rebuttal.citationUrls.length).toBeLessThanOrEqual(3);
      for (const url of rebuttal.citationUrls) expect(isSimulatedUrl(url)).toBe(true);
      seen.add(rebuttal.citationUrls.length);
    }
    // The verdict space stays honest: weak (1) AND strong (3) rebuttals occur.
    expect(seen.has(1)).toBe(true);
    expect(seen.has(3)).toBe(true);
  });

  it('generateReinforcement: keeps the original position, adds an addendum + new sources, caps at 10', () => {
    const original = {
      summary: 'The stated figure does not match the primary series.',
      citationUrls: [
        'https://daily-ledger.example/refs/health-correction-1-0',
        'https://civic-wire.example/refs/health-correction-1-1',
      ],
    };
    const originalHosts = new Set(original.citationUrls.map((url) => new URL(url).hostname));
    for (let i = 0; i < 20; i += 1) {
      const prng = createPrng(`reinf-${i}`);
      const reinforced = generateReinforcement(original, 'health', i, prng);
      // Original material carried forward; genuinely responsive addendum added.
      expect(reinforced.summary.startsWith(original.summary)).toBe(true);
      expect(reinforced.summary.length).toBeGreaterThan(original.summary.length + 40);
      for (const url of original.citationUrls) expect(reinforced.citationUrls).toContain(url);
      expect(reinforced.citationUrls.length).toBeGreaterThan(original.citationUrls.length);
      // Extras land on registrable domains the challenger has NOT already
      // cited — the adjudicator counts independent domains, so a same-domain
      // "extra source" would strengthen nothing.
      for (const url of reinforced.citationUrls.slice(original.citationUrls.length)) {
        expect(originalHosts.has(new URL(url).hostname)).toBe(false);
      }
      // The wire schema's citation ceiling holds even for a large original.
      expect(reinforced.citationUrls.length).toBeLessThanOrEqual(10);
      expect(new Set(reinforced.citationUrls).size).toBe(reinforced.citationUrls.length);
    }
    const bloated = {
      summary: original.summary,
      citationUrls: Array.from({ length: 10 }, (_, i) => `https://o${i}.example/r`),
    };
    const capped = generateReinforcement(bloated, 'health', 99, createPrng('cap'));
    expect(capped.citationUrls.length).toBeLessThanOrEqual(10);
  });

  it('generateReinforcement: an original that EXHAUSTED its bank still gains independent domains', () => {
    // All four health outlets already cited — extras must come from OTHER
    // banks' outlets (cross-domain corroboration), never re-cite a domain.
    const exhausted = {
      summary: 'The stated figure does not match the primary series.',
      citationUrls: [
        'https://daily-ledger.example/refs/x-0',
        'https://metro-monitor.example/refs/x-1',
        'https://civic-wire.example/refs/x-2',
        'https://ward-bulletin.example/refs/x-3',
      ],
    };
    const citedHosts = new Set(exhausted.citationUrls.map((url) => new URL(url).hostname));
    for (let i = 0; i < 20; i += 1) {
      const reinforced = generateReinforcement(exhausted, 'health', i, createPrng(`exh-${i}`));
      const extras = reinforced.citationUrls.slice(exhausted.citationUrls.length);
      expect(extras.length).toBeGreaterThan(0);
      for (const url of extras) {
        const host = new URL(url).hostname;
        expect(citedHosts.has(host)).toBe(false);
        expect(isSimulatedUrl(url)).toBe(true); // still a reserved .example outlet
      }
    }
  });

  it('pickDebateMarker returns only markers the simulated runtime interprets', () => {
    const allowed = new Set([
      '[sim:debate=incumbent]',
      '[sim:debate=challenger]',
      '[sim:debate=inconclusive]',
      '[sim:rationale-url]',
    ]);
    const seen = new Set<string>();
    for (let i = 0; i < 60; i += 1) seen.add(pickDebateMarker(createPrng(`marker-${i}`)));
    for (const marker of seen) expect(allowed.has(marker)).toBe(true);
    // The forced-class markers dominate; every family occurs across seeds.
    expect(seen.size).toBeGreaterThanOrEqual(3);
  });

  it('OVERRIDE_REASONS are substantive and within the override wire bound', () => {
    for (const reason of OVERRIDE_REASONS) {
      expect(reason.length).toBeGreaterThan(20);
      expect(reason.length).toBeLessThanOrEqual(1_000);
    }
  });
});

describe('WS-U problem-comment generator', () => {
  it('spam bodies carry ≥2 distinct spam terms; hostile bodies carry a hostile term', () => {
    const spamTerms = ['discount', 'promo code', 'free money', 'click', 'giveaway', 'cheap'];
    const hostileTerms = ['idiot', 'worthless', 'shut up'];
    for (let i = 0; i < 20; i += 1) {
      const spam = generateProblemComment('spam', 'health', createPrng(`spam-${i}`)).toLowerCase();
      expect(spamTerms.filter((t) => spam.includes(t)).length).toBeGreaterThanOrEqual(2);
      const hostile = generateProblemComment(
        'hostile',
        'climate',
        createPrng(`hostile-${i}`),
      ).toLowerCase();
      expect(hostileTerms.some((t) => hostile.includes(t))).toBe(true);
    }
  });

  it('spam bodies carry ONE real link token; hostile bodies stay link-free', () => {
    // The moderation context counts whitespace-delimited http(s) tokens
    // (governance/forum-agent.ts countLinkTokens) — spam-with-links is what
    // makes the model propose `remove`, exercising the wrapper's
    // escalate-to-review clamp; a link-less spam body could only ever drive
    // flag_for_review.
    const linkTokens = (body: string): string[] =>
      body.split(/\s+/).filter((t) => t.startsWith('https://') || t.startsWith('http://'));
    for (const domain of DOMAIN_IDS) {
      for (let i = 0; i < 10; i += 1) {
        const spam = generateProblemComment('spam', domain, createPrng(`slink-${domain}-${i}`));
        const tokens = linkTokens(spam);
        expect(tokens.length).toBe(1);
        expect(isSimulatedUrl(req(tokens[0]))).toBe(true); // stays on reserved .example hosts
        const hostile = generateProblemComment(
          'hostile',
          domain,
          createPrng(`hlink-${domain}-${i}`),
        );
        expect(linkTokens(hostile)).toHaveLength(0);
      }
    }
  });

  it('problem bodies stay within the comment wire bound and are deterministic per seed', () => {
    for (const kind of ['spam', 'hostile'] as const) {
      const a = generateProblemComment(kind, 'local', createPrng('det'));
      const b = generateProblemComment(kind, 'local', createPrng('det'));
      expect(a).toBe(b);
      expect(a.length).toBeGreaterThan(40);
      expect(a.length).toBeLessThanOrEqual(2_000);
    }
  });
});
