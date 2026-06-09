// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Offline app-shell release gate (WS-C.2.1a / WS-C.2.2, SPEC §6.9). With the
// service worker active and the shell precached, a navigation while offline is
// served the precached app shell (navigateFallback /index.html) rather than the
// browser's offline error — so client-side routing keeps working offline.
import { expect, test } from '@playwright/test';

test.describe('offline app shell (WS-C.2)', () => {
  test('renders the app shell offline from the service-worker precache', async ({
    page,
    context,
  }) => {
    await page.goto('/');
    // Wait for the worker to be installed/activated, then reload so it controls
    // this client (generateSW does not claim clients on first activation).
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload();
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, {
      timeout: 15_000,
    });

    await context.setOffline(true);
    try {
      await page.reload();
      // The bottom navigation (app shell) renders from the precache even offline.
      await expect(page.getByRole('navigation', { name: /Primary navigation/i })).toBeVisible();
    } finally {
      await context.setOffline(false);
    }
  });
});
