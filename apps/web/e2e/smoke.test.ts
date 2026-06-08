// SPDX-License-Identifier: AGPL-3.0-or-later
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

test.describe('smoke', () => {
  test('loads the application', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle(/Licio/);
  });

  test('passes WCAG 2.2 AA accessibility checks', async ({ page }) => {
    await page.goto('/');
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag22aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
});
