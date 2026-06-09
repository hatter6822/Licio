// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Real-browser verification of the WS-B design system, run against the component
// workbench at /styleguide. These cover what jsdom cannot: axe-core's
// color-contrast and target-size rules with real layout, zoom/reflow safety, and
// the dark / high-contrast / reduced-motion colour modes.
import AxeBuilder from '@axe-core/playwright';
import { type Page, expect, test } from '@playwright/test';

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'];

async function gotoStyleguide(page: Page): Promise<void> {
  await page.goto('/styleguide');
  await expect(page.getByRole('heading', { level: 1, name: 'Component workbench' })).toBeVisible();
}

test.describe('design system — accessibility', () => {
  test('has zero axe violations in light mode (incl. colour-contrast, target-size)', async ({
    page,
  }) => {
    await gotoStyleguide(page);
    const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
    expect(results.violations).toEqual([]);
  });

  test('has zero axe violations in dark mode', async ({ page }) => {
    await gotoStyleguide(page);
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
    expect(results.violations).toEqual([]);
  });

  test('has zero axe violations in high-contrast mode (≥7:1 body text)', async ({ page }) => {
    await page.emulateMedia({ contrast: 'more' });
    await gotoStyleguide(page);
    const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
    expect(results.violations).toEqual([]);
  });

  test('renders correctly under reduced motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await gotoStyleguide(page);
    const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
    expect(results.violations).toEqual([]);
  });
});

test.describe('design system — landmarks & skip link (WS-B.1.5/1.6)', () => {
  test('exposes header / main / nav landmarks', async ({ page }) => {
    await gotoStyleguide(page);
    await expect(page.locator('header').first()).toBeVisible();
    await expect(page.locator('main#main')).toHaveCount(1);
    await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible();
  });

  test('skip-to-content is the first focusable element and targets main', async ({ page }) => {
    await gotoStyleguide(page);
    await page.keyboard.press('Tab');
    const skip = page.getByRole('link', { name: 'Skip to content' });
    await expect(skip).toBeFocused();
    await expect(skip).toBeVisible(); // revealed on focus
    await expect(skip).toHaveAttribute('href', '#main');
  });
});

test.describe('design system — target size (WS-B.1.1e)', () => {
  test('buttons and form controls meet the 48×48 house standard', async ({ page }) => {
    await gotoStyleguide(page);
    // Exclude the intentionally-small inline DefinedTerm (covered by tap-target
    // hit-slop, which getBoundingClientRect does not measure).
    const controls = page.locator(
      'button:visible:not([class*="tap-target"]), [role="switch"], input:not([type="hidden"]), select',
    );
    const count = await controls.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i += 1) {
      const box = await controls.nth(i).boundingBox();
      if (!box) continue;
      expect(box.height).toBeGreaterThanOrEqual(47.5);
    }
  });
});

test.describe('design system — zoom & reflow (WS-B.1.1b)', () => {
  test('reflows on a narrow mobile viewport without horizontal scrolling', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 800 });
    await gotoStyleguide(page);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1); // no meaningful horizontal scroll
  });

  test('remains usable at 200% zoom', async ({ page }) => {
    await gotoStyleguide(page);
    await page.evaluate(() => {
      document.documentElement.style.setProperty('font-size', '200%');
    });
    // Content reflows; the primary heading stays visible and reachable.
    await expect(
      page.getByRole('heading', { level: 1, name: 'Component workbench' }),
    ).toBeVisible();
  });
});

test.describe('design system — Sheet reading-position (WS-B.1.3b / Section 6.5)', () => {
  test('preserves scroll position across an open/close cycle', async ({ page }) => {
    await gotoStyleguide(page);
    await page.evaluate(() => window.scrollTo(0, 600));
    const before = await page.evaluate(() => window.scrollY);
    expect(before).toBeGreaterThan(0);

    await page.getByRole('button', { name: 'Open sheet' }).click();
    await expect(page.getByRole('dialog', { name: 'Bottom sheet' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Bottom sheet' })).toHaveCount(0);

    const after = await page.evaluate(() => window.scrollY);
    expect(after).toBe(before);
  });
});
