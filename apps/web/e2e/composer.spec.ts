// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-T route-retirement check: the old eleven-mode ParticipationComposer is no
// longer a live browser surface. Story submission is covered by StoryComposer
// unit tests and BFF story-flow tests; this preview-only E2E keeps the styleguide
// from accidentally reintroducing the retired branch-first composer.
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

test.describe('retired participation composer (WS-T.8)', () => {
  test('styleguide documents retirement instead of mounting the eleven-mode composer', async ({
    page,
  }) => {
    await page.goto('/styleguide');
    await expect(page.getByRole('heading', { name: 'Composer' })).toBeVisible();
    await expect(page.getByText(/legacy participation composer has been retired/i)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'What are you adding?' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Ask:/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Experience:/ })).toHaveCount(0);
  });

  test('retired-composer styleguide state has zero axe violations', async ({ page }) => {
    await page.goto('/styleguide');
    await expect(page.getByText(/comments now live inline on story pages/i)).toBeVisible();
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
});
