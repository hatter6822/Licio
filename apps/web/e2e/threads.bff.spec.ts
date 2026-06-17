// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-G.3.3 thread-discovery E2E (BFF-in-the-loop, WS-P harness). The `/threads`
// tab and the story→conversation link were the gap behind "no threads visible to
// users": the tab was a hardcoded empty state and the story page dropped the
// `thread_id` it already received. This drives the REAL app against the in-memory
// API (seeded with public conversations) to prove a visitor can DISCOVER and OPEN
// a thread. Both surfaces are PUBLIC, so these run LOGGED OUT — the strongest form
// of "visible to users". axe runs in the real browser on the thread detail.
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

const A11Y_TAGS = ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'];
// A served thread URL: /threads/<uuid> (the `?branch=` query may follow).
const THREAD_URL = /\/threads\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
// S1 — the seeded public "water board dataset" story (stable demo id), which has
// a populated, readable thread.
const PUBLIC_STORY_ID = '5f5e1000-0000-4000-8000-000000000001';

test.describe('WS-G.3.3 thread discovery (public, BFF-in-the-loop)', () => {
  test('the /threads tab lists public conversations, each opening its thread', async ({ page }) => {
    await page.goto('/threads');
    await expect(page.getByRole('heading', { name: 'Threads', level: 1 })).toBeVisible();
    // NOT the old hardcoded empty state.
    await expect(page.getByText('No conversations yet')).toHaveCount(0);
    // A conversation links into a thread; open the first.
    const conversation = page.locator('a[href^="/threads/"]').first();
    await expect(conversation).toBeVisible();
    await conversation.click();
    await expect(page).toHaveURL(THREAD_URL, { timeout: 15_000 });
    // The thread detail renders the six structured branches (the WAI-ARIA tablist).
    await expect(page.getByRole('tablist', { name: 'Thread branches' })).toBeVisible();
    const results = await new AxeBuilder({ page }).withTags(A11Y_TAGS).analyze();
    expect(results.violations).toEqual([]);
  });

  test('a story links to its conversation (story → discussion path)', async ({ page }) => {
    await page.goto(`/stories/${PUBLIC_STORY_ID}`);
    // The served `thread_id` becomes a real affordance into the conversation.
    const discussion = page.getByRole('link', { name: 'View the conversation' });
    await expect(discussion).toBeVisible();
    await discussion.click();
    await expect(page).toHaveURL(THREAD_URL, { timeout: 15_000 });
    await expect(page.getByRole('tablist', { name: 'Thread branches' })).toBeVisible();
  });
});
