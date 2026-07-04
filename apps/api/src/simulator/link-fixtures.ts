// SPDX-License-Identifier: AGPL-3.0-or-later
//
// DEV-ONLY link fixtures for the traffic simulator. Simulated link stories
// live on reserved `.example` outlet hosts (RFC 2606 — never routable). This
// module gives the WS-F extraction pipeline a deterministic document for those
// hosts, so a simulated link story runs the REAL robots gate → fetch →
// extraction → normalization → topic-classification path instead of deferring
// forever on unreachable DNS (which would also flood the steward review queue
// with extraction_failure items). Every other URL — anything a human tester
// submits in dev — falls through to the real SSRF-hardened fetcher unchanged.
//
// Wired ONLY by the development boot path in index.ts (dynamic import behind a
// NODE_ENV === 'development' check); production constructs its ingestion
// container without this override.

import { type SafeFetchLimits, type SafeFetchResult, safeFetch } from '../ingestion/safe-fetch.js';
import { isSimulatedUrl } from './content.js';

function titleFromSlug(pathname: string): string {
  const last = pathname.split('/').filter(Boolean).pop() ?? 'simulated-article';
  const words = last.replace(/-\d+$/, '').split('-').filter(Boolean);
  const text = words.join(' ');
  return text.length > 0 ? text.charAt(0).toUpperCase() + text.slice(1) : 'Simulated article';
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** Deterministic article HTML for one simulated URL. */
export function simulatedArticleHtml(url: URL): string {
  const title = escapeHtml(titleFromSlug(url.pathname));
  const section = escapeHtml(url.pathname.split('/').filter(Boolean)[0] ?? 'news');
  const description = `${title} — the full release, published with its methodology and field definitions.`;
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    `<title>${title}</title>`,
    `<meta name="description" content="${escapeHtml(description)}">`,
    `<meta property="og:title" content="${title}">`,
    '<meta property="og:type" content="article">',
    '</head>',
    '<body>',
    '<article>',
    `<h1>${title}</h1>`,
    `<p>The office published the complete ${section} release today, including the raw tables, the processed series, and the methodology appendix that documents how each field was collected.</p>`,
    '<p>Reviewers can compare this cycle against the previous one directly: the release keeps the earlier field definitions and adds a revision history, so every corrected figure is traceable to the page that changed.</p>',
    '<p>The publishing office says the accompanying data dictionary defines each denominator explicitly, and that provisional rows are flagged until validation completes at the end of the reporting window.</p>',
    '</article>',
    '</body>',
    '</html>',
  ].join('\n');
}

/**
 * The fetchDocument override for the dev ingestion container: deterministic
 * documents for the reserved simulator hosts (robots.txt allows everything;
 * article paths serve the fixture page), the real `safeFetch` for everything
 * else. The default robots gate derives from this same function, so simulated
 * origins pass RFC 9309 checks with no further wiring.
 */
export function createSimulatorFetchDocument(): (
  url: string,
  limits: SafeFetchLimits,
) => Promise<SafeFetchResult> {
  return async (rawUrl: string, limits: SafeFetchLimits): Promise<SafeFetchResult> => {
    if (!isSimulatedUrl(rawUrl)) return safeFetch(rawUrl, limits);
    const url = new URL(rawUrl);
    if (url.pathname === '/robots.txt') {
      return {
        ok: true,
        status: 200,
        body: 'User-agent: *\nAllow: /\n',
        contentType: 'text/plain',
        finalUrl: rawUrl,
      };
    }
    return {
      ok: true,
      status: 200,
      body: simulatedArticleHtml(url),
      contentType: 'text/html; charset=utf-8',
      finalUrl: rawUrl,
    };
  };
}
