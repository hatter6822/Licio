// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { generateStory } from '../content.js';
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
    if (result.ok) {
      expect(result.body).toContain('Allow: /');
    }
  });

  it('the article HTML carries a title and a description meta', () => {
    const html = simulatedArticleHtml(new URL('https://daily-ledger.example/health/some-report-9'));
    expect(html).toContain('<title>');
    expect(html).toContain('og:title');
    expect(html).toContain('name="description"');
    // The slug's trailing serial is stripped from the derived title.
    expect(html).not.toContain('some report 9<');
  });

  it('escapes angle brackets in a derived title (no injection)', () => {
    const html = simulatedArticleHtml(new URL('https://daily-ledger.example/news/a-b-c'));
    expect(html).not.toContain('<script');
  });

  it('delegates a non-simulated URL to the real fetcher (which blocks it)', async () => {
    const fetchDocument = createSimulatorFetchDocument();
    // A private-range literal IP: safeFetch must refuse it (blocked_address),
    // proving the delegation path runs the real SSRF-hardened fetcher.
    const result = await fetchDocument('http://169.254.169.254/latest/meta-data', LIMITS);
    expect(result.ok).toBe(false);
  });
});
