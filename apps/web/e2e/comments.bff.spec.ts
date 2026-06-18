// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-T.9.2 comment-flow E2E (BFF-in-the-loop, WS-P harness). The retired
// `/threads` directory/branch reader is replaced by the inline story comment
// section; this drives the real app against the in-memory BFF and keeps the
// accessibility gate on the new canonical conversation surface.
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

const A11Y_TAGS = ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'];
const PUBLIC_STORY_ID = '5f5e1000-0000-4000-8000-000000000001';

test.describe('WS-T comment flow (BFF-in-the-loop)', () => {
  test('story pages expose the inline comment section and legacy thread links redirect to it', async ({
    page,
  }) => {
    await page.goto(`/stories/${PUBLIC_STORY_ID}`);
    await expect(page.getByRole('heading', { name: 'Conversation', level: 2 })).toBeVisible();
    await expect(page.getByLabel('Comment filters')).toBeVisible();
    await expect(page.getByLabel('Write a comment')).toBeVisible();

    const results = await new AxeBuilder({ page }).withTags(A11Y_TAGS).analyze();
    expect(results.violations).toEqual([]);

    const threadResponse = await page.request.get(`/v1/stories/${PUBLIC_STORY_ID}`);
    expect(threadResponse.ok()).toBe(true);
    const story = (await threadResponse.json()) as { thread_id: string };
    await page.goto(`/threads/${story.thread_id}`);
    await expect(page).toHaveURL(new RegExp(`/stories/${PUBLIC_STORY_ID}#comments$`));
    await expect(page.getByRole('heading', { name: 'Conversation', level: 2 })).toBeVisible();
  });
});
