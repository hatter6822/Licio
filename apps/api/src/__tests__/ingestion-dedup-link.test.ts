// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-F.1.3c/d — a LINK story's near-duplicate detection runs over its FETCHED
// article, not its thin submitted text. The submission-time text of a link is
// only its title + a short reason NOTE, so signing + near-dup-matching it there
// would compare a note against other stories' full-content signatures — MinHash
// Jaccard across incomparable text bases — and be immediately superseded by the
// post-fetch `extracted` signature (there is ONE signature per story). So a link
// is signed + matched ONCE, post-fetch, over the article. These tests pin that:
// two links with a SIMILAR reason but DIFFERENT articles are not grouped, while a
// link whose fetched article MATCHES another's is.
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { createV1Routes } from '../routes/v1.js';
import {
  articleHtml,
  freshIngestionServices,
  type IngestionServicesFixture,
  linkSubmission,
  post,
  seedUserWithSession,
} from './ingestion-test-helpers.js';

function app() {
  return new Hono().route('/v1', createV1Routes());
}

let fixture: IngestionServicesFixture;
beforeEach(() => {
  fixture = freshIngestionServices({ config: { minAccountAgeMinutes: 0 } });
});

const RESERVOIR = articleHtml({
  title: 'Reservoir level fell twelve percent in May',
  body: 'The reservoir level fell by twelve percent in May according to the utility report. Officials confirmed the maintenance schedule will continue through August, and the city council approved additional funding for the pipeline replacement over the next three budget cycles.',
});
const ELECTION = articleHtml({
  title: 'Precinct turnout published for the spring cycle',
  body: 'The elections board published precinct-level turnout for the spring cycle, with a data dictionary defining every denominator. A row-level rejection log accompanies the release, and independent observers cross-checked three precincts against the certified canvass.',
});

async function submitLink(
  cookie: string,
  url: string,
  page: string,
  over: Record<string, unknown> = {},
): Promise<{ storyId: string; reviewFlags: string[] }> {
  fixture.pages.set(url, { status: 200, body: page });
  const res = await app().request(post('/v1/stories', linkSubmission(url, over), cookie));
  expect(res.status).toBe(201);
  const json = (await res.json()) as { story_id: string; review_flags: string[] };
  await fixture.ingestion.settle();
  return { storyId: json.story_id, reviewFlags: json.review_flags };
}

async function queueCount(kind: 'near_duplicate' | 'syndication_candidate'): Promise<number> {
  const queued = await fixture.ingestion.reviewQueue.list({ kind, status: 'pending' }, 50);
  return queued.length;
}

describe('WS-F link near-duplicate — deferred to the fetched article', () => {
  it("a link's sole signature is 'extracted' (the thin submitted text is never signed)", async () => {
    const { cookie } = await seedUserWithSession(fixture.identity);
    const { storyId, reviewFlags } = await submitLink(
      cookie,
      'https://a.example/reservoir',
      RESERVOIR,
    );
    // The submission response carries NO sync near-dup flag for a link (deferred).
    expect(reviewFlags).not.toContain('near_duplicate');
    // The single signature is over the FETCHED article, not the submitted note.
    const sig = await fixture.ingestion.signatures.getByStoryId(storyId);
    expect(sig).not.toBeNull();
    expect(sig?.textSource).toBe('extracted');
  });

  it('two links with a SIMILAR reason/title but DIFFERENT articles are not grouped', async () => {
    const { cookie } = await seedUserWithSession(fixture.identity);
    // Identical reason + near-identical titles — the OLD thin-text sync pass
    // would compare these and could false-flag. The articles differ, so the
    // fetched-text pass correctly keeps them apart (no near-dup queued).
    const shared = { reason: 'The full official release, not the press summary.' };
    await submitLink(cookie, 'https://a.example/one', RESERVOIR, {
      ...shared,
      title: 'Official release published for the reporting period',
    });
    await submitLink(cookie, 'https://a.example/two', ELECTION, {
      ...shared,
      title: 'Official release published for the reporting period B',
    });
    expect(await queueCount('near_duplicate')).toBe(0);
    expect(await queueCount('syndication_candidate')).toBe(0);
  });

  it("a link whose fetch FAILS (HTTP 500) still gets a fallback 'submitted' signature", async () => {
    const { cookie } = await seedUserWithSession(fixture.identity);
    // robots allows (no entry ⇒ 404 ⇒ allowed), but the fetch returns HTTP 500 —
    // the retryable failed path, which may never succeed for a dead link. It must
    // still leave a signature row so the story is a groupable near-dup candidate.
    fixture.pages.set('https://broken.example/report', { status: 500, body: '' });
    const res = await app().request(
      post('/v1/stories', linkSubmission('https://broken.example/report'), cookie),
    );
    expect(res.status).toBe(201);
    const { story_id } = (await res.json()) as { story_id: string };
    await fixture.ingestion.settle();
    const sig = await fixture.ingestion.signatures.getByStoryId(story_id);
    expect(sig).not.toBeNull();
    expect(sig?.textSource).toBe('submitted');
  });

  it("a robots-disallowed link (no fetched article) still gets a fallback 'submitted' signature", async () => {
    const { cookie } = await seedUserWithSession(fixture.identity);
    // Disallow crawling for this origin so the pipeline degrades to link-only
    // (no article is ever fetched).
    fixture.robots.set('https://blocked.example', 'User-agent: *\nDisallow: /');
    const { storyId } = await submitLink(cookie, 'https://blocked.example/report', RESERVOIR, {
      reason: 'The quarterly reservoir report, first posting, with the full utility figures.',
    });
    // A link normally defers signing to its article, but with no reachable
    // article the submitted title+reason is signed as a fallback — so the story
    // is still groupable rather than having no signature row at all.
    const sig = await fixture.ingestion.signatures.getByStoryId(storyId);
    expect(sig).not.toBeNull();
    expect(sig?.textSource).toBe('submitted');
  });

  it('two identical robots-disallowed links are grouped by their fallback signatures', async () => {
    const { cookie } = await seedUserWithSession(fixture.identity);
    fixture.robots.set('https://wall.example', 'User-agent: *\nDisallow: /');
    // Pin BOTH the title AND the reason so the signed fallback text (title +
    // reason — submissionBodyText for a link is its reason) is IDENTICAL across
    // the two submissions: a verbatim repost of the same blocked link. (The
    // default linkSubmission title is randomised per call, which would make the
    // MinHash estimate — and thus the pass/fail — non-deterministic.) Only the
    // URL differs, so these are two distinct stories the screen must group.
    const shared = {
      title: 'The blocked utility report on the reservoir figures, verbatim repost',
      reason:
        'The identical inaccessible-link reason note, repeated verbatim across both submissions of this same blocked utility report for the near-duplicate screen.',
    };
    await submitLink(cookie, 'https://wall.example/a', RESERVOIR, shared);
    await submitLink(cookie, 'https://wall.example/b', RESERVOIR, shared);
    // The link-only path runs the SAME public near-dup screen the fetched path
    // runs, over the fallback signatures — so repeated inaccessible links group.
    expect(await queueCount('near_duplicate')).toBeGreaterThanOrEqual(1);
  });

  it('a same-source link whose fetched article DUPLICATES another is grouped as a near-duplicate', async () => {
    const { cookie } = await seedUserWithSession(fixture.identity);
    // Same origin (same source) + the same article text, a different URL/title —
    // the verbatim repost the post-fetch pass groups as a near-duplicate.
    await submitLink(cookie, 'https://a.example/original', RESERVOIR, {
      title: 'Reservoir report, first posting',
    });
    await submitLink(cookie, 'https://a.example/reposted', RESERVOIR, {
      title: 'Reservoir report, second posting',
      reason: 'Same report, reposted.',
    });
    expect(await queueCount('near_duplicate')).toBeGreaterThanOrEqual(1);
  });
});
