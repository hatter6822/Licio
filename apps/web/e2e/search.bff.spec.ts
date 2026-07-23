// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Public-content search E2E (BFF-in-the-loop): the real React app queries the
// REAL in-memory search engine over the seeded demo corpus — anonymously, as a
// signed-out reader. Proves the reader path end to end: stories, comments, and
// rooms surface; navigation lands on the destination; the SCOPED surfaces
// (a story's conversation, a room's pool) narrow the corpus for real; and the
// WS-Q containment holds live (a private room's room_only story never appears
// in global search).
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

const A11Y_TAGS = ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'];

async function openSearch(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Search' }).click();
  const input = page.getByRole('combobox', { name: 'Search public content' });
  await expect(input).toBeFocused();
  return input;
}

test.describe('search over the seeded corpus (anonymous, BFF-in-the-loop)', () => {
  test('finds a seeded public story and navigates to it', async ({ page }) => {
    const input = await openSearch(page);
    await input.fill('testing dataset');
    const hit = page.getByRole('option', {
      name: /Regional water board publishes the full testing dataset/,
    });
    await expect(hit).toBeVisible();

    const results = await new AxeBuilder({ page }).withTags(A11Y_TAGS).analyze();
    expect(results.violations).toEqual([]);

    await hit.click();
    await expect(page).toHaveURL(/\/stories\//);
    await expect(
      page.getByRole('heading', {
        name: /Regional water board publishes the full testing dataset/,
      }),
    ).toBeVisible();
  });

  test('surfaces seeded comments and rooms', async ({ page }) => {
    const input = await openSearch(page);
    // A seeded discussion comment ("Independent ISO data agrees with the
    // normalized read.") — comment hits are labelled with their parent story.
    await input.fill('normalized');
    await expect(page.getByRole('option', { name: /^Comment on / }).first()).toBeVisible();

    // The seeded PUBLIC topic room surfaces by name.
    await input.fill('harbor district');
    await expect(page.getByRole('option', { name: /Harbor District/ })).toBeVisible();
  });

  test('scoped: the story banner searches THAT story’s conversation only', async ({ page }) => {
    // Reach a seeded story through the global surface, then use its own banner.
    const input = await openSearch(page);
    await input.fill('testing dataset');
    await page
      .getByRole('option', { name: /Regional water board publishes the full testing dataset/ })
      .click();
    await expect(page).toHaveURL(/\/stories\//);

    await page.getByRole('button', { name: 'Search this conversation' }).click();
    const scoped = page.getByRole('combobox', { name: 'Search this conversation' });
    await expect(scoped).toBeFocused();
    // The dialog NAMES the corpus it is searching…
    await expect(page.getByText('Searching within')).toBeVisible();
    // …and offers no type filters: a story's conversation is comments only.
    await expect(page.getByRole('group', { name: 'Filter results by type' })).toHaveCount(0);

    // A seeded comment on THIS story is found ("The methodology appendix covers
    // May through October…"), labelled with its parent story.
    await scoped.fill('methodology appendix');
    await expect(page.getByRole('option', { name: /^Comment on / }).first()).toBeVisible();

    // …while a term that matches only OTHER content returns nothing here: the
    // seeded public room "Harbor District" is a global-surface hit, and a room
    // is never a result inside a story's conversation.
    await scoped.fill('harbor district');
    await expect(page.getByText(/No results for/)).toBeVisible();
  });

  test('WS-Q containment: a private room_only story never surfaces globally', async ({ page }) => {
    const input = await openSearch(page);
    // The seeded PRIVATE Transit Working Group holds the room_only story
    // "Claim about the new transit timetable is missing a key caveat".
    await input.fill('transit timetable');
    // Wait for the query to COMPLETE (it renders either the empty state or
    // some results) so the absence assertion below cannot pass vacuously
    // against a request that never landed.
    await expect(
      page.getByText(/No results for/).or(page.getByRole('option').first()),
    ).toBeVisible();
    await expect(page.getByRole('option', { name: /transit timetable/i })).toHaveCount(0);
  });
});
