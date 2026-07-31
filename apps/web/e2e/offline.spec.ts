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
    browserName,
  }) => {
    // Playwright's offline + service-worker emulation is reliable on Chromium;
    // Firefox/WebKit drivers don't faithfully serve a controlled-SW navigation
    // under setOffline. The rest of the suite still runs on all three browsers.
    test.skip(browserName !== 'chromium', 'SW offline emulation is validated on Chromium');
    await page.goto('/');
    // Wait for the worker to be installed/activated, then reload so it controls
    // this client (generateSW does not claim clients on first activation).
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload();
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, {
      timeout: 15_000,
    });
    // A CONTROLLING worker is not the same as a POPULATED precache, and this
    // test needs the second.  Waiting only for the controller made the offline
    // reload fail with ERR_INTERNET_DISCONNECTED on a loaded machine — a
    // genuine race the assertion could not distinguish from a broken shell.
    // Ask the cache directly for the one entry the navigation fallback serves.
    await page.waitForFunction(
      async () => {
        for (const name of await caches.keys()) {
          const cache = await caches.open(name);
          for (const request of await cache.keys()) {
            if (new URL(request.url).pathname === '/index.html') return true;
          }
        }
        return false;
      },
      null,
      { timeout: 15_000 },
    );

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
