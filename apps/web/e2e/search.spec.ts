// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Public-content search modal (WS-F.3.1b), frontend-only: the banner's circular
// looking-glass button and the Ctrl/Cmd+K hotkey open an accessible top-anchored
// dialog whose results come from the stubbed `GET /v1/search`. Network is
// mocked at the page layer (the preview server serves static assets only); the
// authenticated/seeded flow lives in search.bff.spec.ts. axe runs with the
// dialog open.
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

const A11Y_TAGS = ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'];
const STORY_ID = '5f5e1000-0000-4000-8000-000000000001';
const COMMENT_ID = '5f5e1000-0000-4000-8000-000000000002';
const COMMENT_STORY_ID = '5f5e1000-0000-4000-8000-000000000003';
const ROOM_ID = '5f5e1000-0000-4000-8000-000000000004';

test.use({ serviceWorkers: 'block' });

async function stubApp(page: Page): Promise<void> {
  await page.route('**/v1/feature-flags', (route) => route.fulfill({ json: { flags: {} } }));
  await page.route('**/v1/auth/status', (route) =>
    route.fulfill({ json: { authenticated: false, user: null } }),
  );
  await page.route('**/v1/telemetry', (route) => route.fulfill({ status: 204 }));
  await page.route('**/v1/security/link-blocklist', (route) =>
    route.fulfill({ json: { blocked: [] } }),
  );
  await page.route('**/v1/feed*', (route) =>
    route.fulfill({ json: { items: [], nextCursor: null } }),
  );
  await page.route('**/v1/search*', (route) =>
    route.fulfill({
      json: {
        items: [
          {
            result_type: 'story',
            id: STORY_ID,
            story_id: STORY_ID,
            title: 'Reservoir level fell in May',
            snippet: 'Utility data shows a sharp reservoir decline.',
            relevance: 1.4,
            created_at: '2026-07-01T00:00:00.000Z',
            dispute_status: 'validated',
          },
          {
            result_type: 'comment',
            id: COMMENT_ID,
            story_id: COMMENT_STORY_ID,
            title: 'Reservoir maintenance schedule',
            snippet: 'The reservoir reading stands confirmed by the appendix.',
            relevance: 0.5,
            created_at: '2026-07-02T00:00:00.000Z',
            dispute_status: 'none',
          },
          {
            result_type: 'room',
            id: ROOM_ID,
            story_id: null,
            title: 'Reservoir watchers',
            snippet: 'A room about reservoir telemetry.',
            relevance: 0.4,
            created_at: '2026-07-03T00:00:00.000Z',
            dispute_status: 'none',
          },
        ],
        nextCursor: null,
      },
    }),
  );
}

test.describe('search modal (WS-F.3.1b, mocked API)', () => {
  test('banner button opens the dialog; results render sectioned with the WS-T badge', async ({
    page,
  }) => {
    await stubApp(page);
    await page.goto('/');
    // The front-page banner carries the circular search button where the
    // visible title used to be; the <h1> stays for AT.
    const button = page.getByRole('button', { name: 'Search' });
    await expect(button).toBeVisible();
    await button.click();

    const dialog = page.getByRole('dialog', { name: 'Search' });
    await expect(dialog).toBeVisible();
    const input = page.getByRole('combobox', { name: 'Search public content' });
    await expect(input).toBeFocused();

    await input.fill('reservoir');
    await expect(page.getByRole('option', { name: /Reservoir level fell in May/ })).toBeVisible();
    await expect(
      page.getByRole('option', { name: /Comment on Reservoir maintenance schedule/ }),
    ).toBeVisible();
    await expect(page.getByRole('option', { name: /Reservoir watchers/ })).toBeVisible();
    // WS-T: the validated hit is labelled (content integrity, never applause).
    await expect(dialog.getByText('Validated')).toBeVisible();

    const results = await new AxeBuilder({ page }).withTags(A11Y_TAGS).analyze();
    expect(results.violations).toEqual([]);
  });

  test('keyboard: Ctrl+K toggles; Escape closes and restores focus; Enter opens a result', async ({
    page,
  }) => {
    await stubApp(page);
    await page.goto('/');
    const button = page.getByRole('button', { name: 'Search' });
    await expect(button).toBeVisible();

    await button.click();
    await expect(page.getByRole('dialog', { name: 'Search' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Search' })).toHaveCount(0);
    // Focus returns to the trigger (the focus-trap contract).
    await expect(button).toBeFocused();

    await page.keyboard.press('Control+k');
    const input = page.getByRole('combobox', { name: 'Search public content' });
    await expect(input).toBeFocused();
    await input.fill('reservoir');
    await expect(page.getByRole('option', { name: /Reservoir level fell in May/ })).toBeVisible();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`/stories/${STORY_ID}`));
  });
});
