// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-T.9.2 comment-flow E2E (BFF-in-the-loop, WS-P harness). The retired
// `/threads` directory/branch reader is replaced by the inline story comment
// section; this drives the real app against the in-memory BFF and keeps the
// accessibility gate on the new canonical conversation surface.
//
// "Comment FLOW" includes the WRITE: the last test drives an authenticated
// story detail → composer → real `POST /v1/stories/:id/comments` → CSRF
// round-trip → query invalidation → re-render, and then RELOADS, so a schema
// drift, a CSRF-serialization failure, or a WS-U agent-moderator fault on the
// post path fails here rather than reaching a user who finds a comment box
// that silently does nothing.
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

const A11Y_TAGS = ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'];
const PUBLIC_STORY_ID = '5f5e1000-0000-4000-8000-000000000001';

// `POST /v1/contributions` sits behind `requireVerifiedAccount()` (WS-D.1.6a:
// a passkey, an auth wallet, or a verified email). The seed AUTHOR the
// test-auth route logs in by default (`licio_demo`) is a content row with no
// credential at all, so it 403s `verification_required` — the write path is
// only reachable as one of the seeded dev members. `licio_expert` is the one
// whose extra role unlocks no console, so it is the closest thing the harness
// has to an ordinary verified member.
const VERIFIED_MEMBER_ID = '5f5e0000-0000-4000-8000-000000000022';

/** Mint a session via the test-only route, then wait for the client auth store
 *  to hydrate (confirmSession persists `licio:auth` on success). */
async function loginAndReady(page: Page, userId?: string): Promise<void> {
  const res = await page.request.post('/v1/test-auth/login', {
    data: userId === undefined ? {} : { userId },
  });
  expect(res.ok()).toBeTruthy();
  await page.goto('/');
  await page.waitForFunction(() => localStorage.getItem('licio:auth') !== null, null, {
    timeout: 15_000,
  });
}

test.describe('WS-T comment flow (BFF-in-the-loop)', () => {
  test('story pages expose the inline comment section and legacy thread links redirect to it', async ({
    page,
  }) => {
    await page.goto(`/stories/${PUBLIC_STORY_ID}`);
    await expect(page.getByRole('region', { name: 'Conversation' })).toBeVisible();
    await expect(page.getByLabel('Write a comment')).toBeVisible();

    const results = await new AxeBuilder({ page }).withTags(A11Y_TAGS).analyze();
    expect(results.violations).toEqual([]);

    const threadResponse = await page.request.get(`/v1/stories/${PUBLIC_STORY_ID}`);
    expect(threadResponse.ok()).toBe(true);
    const story = (await threadResponse.json()) as { thread_id: string };
    await page.goto(`/threads/${story.thread_id}`);
    await expect(page).toHaveURL(new RegExp(`/stories/${PUBLIC_STORY_ID}#comments$`));
    await expect(page.getByRole('region', { name: 'Conversation' })).toBeVisible();
  });

  test('the dedicated comment page opens as a comments-only reading view and returns to the story', async ({
    page,
  }) => {
    await page.goto(`/stories/${PUBLIC_STORY_ID}/comments`);
    // The comments-only page: its own <h1>, no story body — just the conversation.
    await expect(page.getByRole('heading', { name: 'Comments', level: 1 })).toBeVisible();

    const results = await new AxeBuilder({ page }).withTags(A11Y_TAGS).analyze();
    expect(results.violations).toEqual([]);

    // The upper-left page-header back button lands back on the story's comment
    // section (the duplicate lower "Back to the story" link was removed).
    await page.getByRole('button', { name: /go back/i }).click();
    await expect(page).toHaveURL(new RegExp(`/stories/${PUBLIC_STORY_ID}#comments$`));
    await expect(page.getByRole('region', { name: 'Conversation' })).toBeVisible();
  });

  test('an authenticated member posts a comment that survives a reload', async ({ page }) => {
    // A nonce per run: the in-memory server is reused across a local re-run, so
    // a fixed body would match an earlier run's comment and prove nothing.
    const body = `The appendix contradicts the summary here ${Date.now()}`;
    await loginAndReady(page, VERIFIED_MEMBER_ID);
    await page.goto(`/stories/${PUBLIC_STORY_ID}`);

    await page.getByRole('textbox', { name: 'Write a comment' }).fill(body);
    // `exact` so this never matches the "Comments" affordances on the page.
    await page.getByRole('button', { name: 'Comment', exact: true }).click();

    // Match the posted COMMENT, never the composer: `getByText` matches a
    // textarea by its value, so asserting on the body text alone is satisfied
    // by the text still sitting in the editor — a green test over a write that
    // never happened. Comments render as <article>; the story's own <article>
    // sits outside the conversation region and never carries this text.
    const posted = page.getByRole('article').filter({ hasText: body });
    await expect(posted).toHaveCount(1, { timeout: 15_000 });

    // The reload is the point: it re-reads the list from the BFF, so a cache
    // echo — or a write the server rejected after the UI had already moved
    // on — cannot satisfy this assertion.
    await page.reload();
    await expect(posted).toHaveCount(1, { timeout: 15_000 });
    await expect(posted).toBeVisible();
  });
});
