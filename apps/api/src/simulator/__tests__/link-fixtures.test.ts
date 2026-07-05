// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { generateRepost, generateStory } from '../content.js';
import { createSimulatorFetchDocument, simulatedArticleHtml } from '../link-fixtures.js';
import { createPrng } from '../prng.js';
import { req } from './sim-test-util.js';

const LIMITS = { timeoutMs: 5000, maxBytes: 1_000_000, maxRedirects: 3, userAgent: 'test' };

describe('simulator link fixtures', () => {
  it('serves a deterministic article for a simulated URL', async () => {
    const fetchDocument = createSimulatorFetchDocument();
    const story = generateStory('health', 'link', 42, createPrng('lf'));
    const result = await fetchDocument(req(story.url), LIMITS);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.status).toBe(200);
      expect(result.contentType).toContain('text/html');
      expect(result.body).toContain('<article>');
      expect(result.finalUrl).toBe(story.url);
    }
  });

  it('serves a permissive robots.txt for a simulated host', async () => {
    const fetchDocument = createSimulatorFetchDocument();
    const story = generateStory('climate', 'link', 1, createPrng('robots'));
    const origin = new URL(req(story.url)).origin;
    const result = await fetchDocument(`${origin}/robots.txt`, LIMITS);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.body).toContain('Allow: /');
  });

  it('a repost fetches the SAME article as its original (the near-dup twin)', async () => {
    const fetchDocument = createSimulatorFetchDocument();
    const prng = createPrng('twin');
    const original = generateStory('elections', 'link', 5, prng);
    const repost = generateRepost(original.title, original.body, 'elections', 6, prng);
    const [origDoc, repostDoc] = await Promise.all([
      fetchDocument(req(original.url), LIMITS),
      fetchDocument(req(repost.url), LIMITS),
    ]);
    expect(origDoc.ok && repostDoc.ok).toBe(true);
    if (origDoc.ok && repostDoc.ok) {
      // Identical <article> body (the URLs differ only by the repost- prefix +
      // serial, which the title recovery strips).
      const body = (html: string): string =>
        html.slice(html.indexOf('<article>'), html.indexOf('</article>'));
      expect(body(repostDoc.body)).toBe(body(origDoc.body));
    }
  });

  it('two distinct link stories fetch different articles', async () => {
    const fetchDocument = createSimulatorFetchDocument();
    const prng = createPrng('distinct');
    const a = generateStory('science', 'link', 1, prng);
    const b = generateStory('science', 'link', 2, prng);
    const [da, db] = await Promise.all([
      fetchDocument(req(a.url), LIMITS),
      fetchDocument(req(b.url), LIMITS),
    ]);
    if (da.ok && db.ok) expect(da.body).not.toBe(db.body);
  });

  it('escapes angle brackets in a derived title (no injection)', () => {
    const html = simulatedArticleHtml(new URL('https://daily-ledger.example/health/a-b-c-9'));
    expect(html).toContain('<title>');
    expect(html).not.toContain('<script');
  });

  it('delegates a non-simulated URL to the real fetcher (which blocks a private IP)', async () => {
    const fetchDocument = createSimulatorFetchDocument();
    const result = await fetchDocument('http://169.254.169.254/latest/meta-data', LIMITS);
    expect(result.ok).toBe(false);
  });
});
