// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The FRONT PAGE over the real BFF (WS-P harness) — the primary surface, and the
// one the frontend-only suite could not judge.
//
// That suite runs against the static preview with no API behind it, so `/` shows
// a "Loading…" skeleton forever: an axe scan there judges a heading and a
// spinner, and a story card that lost its accessible name would ship green.
// (The Rooms route solves this by stubbing the list before scanning; the feed's
// cards carry far more structure — links, dispute badges, media, signal rows —
// and deserve the REAL payload rather than a hand-written stand-in.)
//
// So the front-page gates live here, where the seeded corpus is served through
// the production read path.  Anonymous on purpose: the front page is what a
// signed-out visitor meets first.
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

const A11Y_TAGS = ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'];

/** Wait for real feed CONTENT — never the skeleton the scan must not judge. */
async function feedLoaded(page: Page): Promise<void> {
  await page.goto('/');
  // A seeded story headline: proof the API answered and the cards rendered.
  await expect(
    page.getByRole('heading', { name: /Regional water board publishes the full testing dataset/ }),
  ).toBeVisible({ timeout: 15_000 });
  // And no skeleton is left behind mid-scan.
  await expect(page.getByText(/^Loading…$/)).toHaveCount(0);
}

test.describe('front page over the seeded corpus (anonymous, BFF-in-the-loop)', () => {
  test('renders real story cards, not a skeleton', async ({ page }) => {
    await feedLoaded(page);
    // More than one card, and real links: a single lucky render would not
    // exercise the list, and a skeleton has neither.
    expect(await page.locator('main h2, main h3').count()).toBeGreaterThan(1);
    expect(await page.locator('main a').count()).toBeGreaterThan(0);
  });

  test('has zero axe violations, and the scan actually JUDGED the cards', async ({ page }) => {
    await feedLoaded(page);
    const results = await new AxeBuilder({ page }).withTags(A11Y_TAGS).analyze();
    expect(results.violations).toEqual([]);
    // An empty violations list is what a skeleton scan returns too, so the
    // assertion that matters is that the rules had NODES to judge.  A passing
    // rule appears in `passes` only when it inspected at least one element, so
    // these three name the structure the front page is made of: named links,
    // ordered headings, and readable text over the card surfaces.
    const inspected = new Set(results.passes.map((rule) => rule.id));
    expect([...inspected]).toEqual(expect.arrayContaining(['link-name']));
    expect(inspected.has('color-contrast') || inspected.has('color-contrast-enhanced')).toBe(true);
    // …and the link rule saw the whole list, not one stray anchor.
    const linkNameNodes = results.passes.find((rule) => rule.id === 'link-name')?.nodes.length ?? 0;
    expect(linkNameNodes).toBeGreaterThan(1);
  });
});
