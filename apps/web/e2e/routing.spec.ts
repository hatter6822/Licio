// SPDX-License-Identifier: AGPL-3.0-or-later
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

test.describe('routing (WS-C.1.1)', () => {
  test('navigates the primary tabs client-side with aria-current', async ({ page }) => {
    await page.goto('/');
    // Tag the window; a full-page reload would clear it, so its persistence
    // proves navigation was client-side (no reload).
    await page.evaluate(() => {
      (window as unknown as { __spa: boolean }).__spa = true;
    });

    const roomsTab = page.getByRole('link', { name: 'Rooms' }).first();
    await roomsTab.click();
    await expect(page).toHaveURL(/\/rooms$/);
    await expect(roomsTab).toHaveAttribute('aria-current', 'page');

    const stillSpa = await page.evaluate(
      () => (window as unknown as { __spa?: boolean }).__spa === true,
    );
    expect(stillSpa).toBe(true);

    await page.getByRole('link', { name: 'Front Page' }).first().click();
    await expect(page).toHaveURL(/\/(\?.*)?$/);
  });

  test('redirects an auth-guarded route to login', async ({ page }) => {
    await page.goto('/profile');
    await expect(page).toHaveURL(/\/login/);
  });

  test('renders RestrictedState for a flag-gated route (fail-closed)', async ({ page }) => {
    await page.goto('/rooms/11111111-1111-4111-8111-111111111111/governance');
    await expect(page.getByRole('heading', { level: 1, name: /Room governance/i })).toBeVisible();
    await expect(page.getByText(/Governance features are not enabled/i)).toBeVisible();
  });

  test('renders a not-found state inside the shell for an unknown path', async ({ page }) => {
    await page.goto('/this-route-does-not-exist');
    // The bottom navigation (app shell) is still present — not a hard 404 page.
    await expect(page.getByRole('navigation', { name: /Primary navigation/i })).toBeVisible();
  });

  test('passes WCAG 2.2 AA checks on the Rooms route', async ({ page }) => {
    await page.goto('/rooms');
    await expect(page.locator('main h1')).toBeVisible();
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag22aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
});
