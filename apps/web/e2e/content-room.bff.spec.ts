// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-Q content-room AUTHENTICATED E2E (BFF-in-the-loop, WS-P harness). Drives the
// real React app against the in-memory API: a test-only login mints the session
// (no WebAuthn ceremony in a headless browser), then the browser exercises
// compose → submit (WS-Q.5.1) and a private-room member seeing a room_only item
// with the in-room chip (WS-Q.5.3b). axe runs in the real browser on the
// composer and the room shell.
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

// The seeded private room (Transit Working Group) the demo user stewards/joins.
const PRIVATE_ROOM_ID = '5f5e3000-0000-4000-8000-000000000003';
const A11Y_TAGS = ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'];

/** Mint the demo session via the test-only route, then wait for the client auth
 *  store to hydrate (confirmSession persists `licio:auth` on success). */
async function loginAndReady(page: Page): Promise<void> {
  const res = await page.request.post('/v1/test-auth/login', { data: {} });
  expect(res.ok()).toBeTruthy();
  await page.goto('/');
  await page.waitForFunction(() => localStorage.getItem('licio:auth') !== null, null, {
    timeout: 15_000,
  });
}

test.describe('WS-Q content-room (authenticated, BFF-in-the-loop)', () => {
  test('composes and submits a link to Commons, landing on the story page', async ({ page }) => {
    // A unique URL + title per run so canonical-URL dedup never 409s on re-runs
    // against a reused in-memory server.
    const nonce = Date.now();
    const title = `A primary-source water report ${nonce}`;
    await loginAndReady(page);
    await page.goto('/submit');
    // The story composer (no thread target) renders with the required room picker.
    await expect(page.getByText('Commons')).toBeVisible();
    await page.getByLabel(/^title/i).fill(title);
    await page.getByLabel(/link url/i).fill(`https://example.org/e2e-water-report-${nonce}`);
    await page.getByLabel(/why this matters/i).fill('Links the full dataset, not a summary.');
    // At least one topic PROPOSAL is required before submitting (WS-K §24.1).
    await page.getByRole('button', { name: 'Climate & Environment' }).click();
    await page.getByRole('button', { name: /^post$/i }).click();
    // onSubmitted navigates to the new story's page.
    await expect(page).toHaveURL(/\/stories\//, { timeout: 15_000 });
    await expect(page.getByText(title)).toBeVisible();
  });

  test('the story composer has zero axe violations', async ({ page }) => {
    await loginAndReady(page);
    await page.goto('/submit');
    await expect(page.getByText('Commons')).toBeVisible();
    const results = await new AxeBuilder({ page }).withTags(A11Y_TAGS).analyze();
    expect(results.violations).toEqual([]);
  });

  test('a private-room member sees a room_only item with the in-room chip', async ({ page }) => {
    await loginAndReady(page);
    await page.goto(`/rooms/${PRIVATE_ROOM_ID}`);
    await expect(page.getByText('Transit Working Group')).toBeVisible();
    // The seeded room_only story renders for the member, tagged with the chip.
    await expect(page.getByText(/missing a key caveat/i)).toBeVisible();
    await expect(page.getByText('In room').first()).toBeVisible();
    const results = await new AxeBuilder({ page }).withTags(A11Y_TAGS).analyze();
    expect(results.violations).toEqual([]);
  });
});
