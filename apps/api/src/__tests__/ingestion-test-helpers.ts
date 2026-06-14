// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Ingestion in-memory test fixtures: fresh identity + events + ingestion
// bundles (installed as the module singletons), a stubbed document fetcher
// with per-URL HTML fixtures, robots control, and canonical submission
// bodies. The ingestion bundle's `settle()` makes the detached pipeline
// deterministic in tests.
import { randomUUID } from 'node:crypto';
import { COMMONS_ROOM_ID, type StoryCreateRequest } from '@licio/shared';
import type { EventPipelineServices } from '../events/services.js';
import {
  createInMemoryForumServices,
  type ForumServices,
  setForumServices,
} from '../forum/services.js';
import type { IdentityServices } from '../identity/services.js';
import type { IngestionRuntimeConfig } from '../ingestion/config.js';
import type { SafeFetchResult } from '../ingestion/safe-fetch.js';
import {
  createInMemoryIngestionServices,
  type IngestionServices,
  registerIngestionConsumers,
  setIngestionServices,
} from '../ingestion/services.js';
import { freshEventServices, seedUserWithSession } from './event-test-helpers.js';

export { seedUserWithSession };

export interface IngestionServicesFixture {
  identity: IdentityServices;
  events: EventPipelineServices;
  ingestion: IngestionServices;
  forum: ForumServices;
  /** Per-URL fetch fixtures (status/body); unlisted URLs 404. `finalUrl`
   *  simulates a redirect — the fetcher reports it as the post-redirect URL. */
  pages: Map<string, { status: number; body: string; contentType?: string; finalUrl?: string }>;
  /** robots.txt body served per origin; absent ⇒ 404 (no restrictions). */
  robots: Map<string, string>;
  fetchedUrls: string[];
}

/** Fresh in-memory WS-D + WS-E + WS-F bundles with consumers registered. */
export function freshIngestionServices(
  options: {
    config?: Partial<IngestionRuntimeConfig>;
    now?: () => number;
    /** Mirror the boot-path dev/test escape hatch (default false ⇒ gate ON). */
    skipAccountAgeGate?: boolean;
  } = {},
): IngestionServicesFixture {
  const { identity, events } = freshEventServices(options.now ? { now: options.now } : {});
  const pages = new Map<
    string,
    { status: number; body: string; contentType?: string; finalUrl?: string }
  >();
  const robots = new Map<string, string>();
  const fetchedUrls: string[] = [];
  const fetchDocument = async (url: string): Promise<SafeFetchResult> => {
    fetchedUrls.push(url);
    const page = pages.get(url);
    if (!page) return { ok: true, status: 404, body: '', contentType: null, finalUrl: url };
    return {
      ok: true,
      status: page.status,
      body: page.body,
      contentType: page.contentType ?? 'text/html',
      finalUrl: page.finalUrl ?? url,
    };
  };
  const ingestion = createInMemoryIngestionServices({
    events,
    fetchDocument,
    robotsFetcher: async (origin) => {
      const body = robots.get(origin);
      if (body === undefined) return { status: 404, body: '' };
      return { status: 200, body };
    },
    ...(options.config ? { config: options.config } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.skipAccountAgeGate !== undefined
      ? { skipAccountAgeGate: options.skipAccountAgeGate }
      : {}),
  });
  registerIngestionConsumers(events, ingestion);
  setIngestionServices(ingestion);
  // WS-Q — the submission guards + the in-memory global-search room-visibility
  // predicate need a forum (its room store self-seeds the public Commons room
  // and wires the search room-visibility provider via the ingestion hook).
  const forum = createInMemoryForumServices({ events, ingestion });
  setForumServices(forum);
  return { identity, events, ingestion, forum, pages, robots, fetchedUrls };
}

/** Canonical valid bodies for each §14.1 submission type. */
export function linkSubmission(url: string, over: Partial<StoryCreateRequest> = {}) {
  return {
    submission_type: 'link',
    url,
    reason: 'Primary source for the development',
    title: `Linked story ${randomUUID().slice(0, 8)}`,
    topic_ids: [randomUUID()],
    // WS-Q — every submission picks a home room (Commons by default; the
    // in-memory store self-seeds it and the public+open room auto-joins).
    room_id: COMMONS_ROOM_ID,
    ...over,
  };
}

export function briefSubmission(over: Record<string, unknown> = {}) {
  return {
    submission_type: 'original_brief',
    body: 'The council voted 7 to 2 to approve the new reservoir bond on Tuesday evening.',
    title: `Brief ${randomUUID().slice(0, 8)}`,
    topic_ids: [randomUUID()],
    room_id: COMMONS_ROOM_ID,
    ...over,
  };
}

/** A realistic article page with the full metadata channel set. */
export function articleHtml(
  over: { title?: string; body?: string; lang?: string; robotsMeta?: string } = {},
): string {
  const body =
    over.body ??
    'The reservoir level fell by 12 percent in May according to the utility report. Officials confirmed the maintenance schedule will continue through August. The city council approved additional funding for the pipeline replacement.';
  return `<!doctype html>
<html lang="${over.lang ?? 'en'}">
<head>
  <title>${over.title ?? 'Reservoir level fell 12% in May'}</title>
  <meta property="og:title" content="${over.title ?? 'Reservoir level fell 12% in May'}">
  <meta property="og:site_name" content="Example News">
  <meta property="og:type" content="article">
  <meta property="og:description" content="Utility data shows a sharp reservoir decline.">
  <meta name="author" content="A. Reporter">
  <meta property="article:published_time" content="2026-06-10T08:00:00Z">
  ${over.robotsMeta !== undefined ? `<meta name="robots" content="${over.robotsMeta}">` : ''}
  <script type="application/ld+json">{"@type":"NewsArticle","headline":"Reservoir article","author":{"name":"A. Reporter"},"publisher":{"name":"Example News"},"datePublished":"2026-06-10T08:00:00Z"}</script>
</head>
<body>
  <article><p>${body}</p></article>
  <script>var tracking = "never extracted as text";</script>
</body>
</html>`;
}

export function jsonHeaders(cookie?: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    ...(cookie !== undefined ? { cookie } : {}),
  };
}

export function post(path: string, body: unknown, cookie?: string): Request {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: jsonHeaders(cookie),
    body: JSON.stringify(body),
  });
}
