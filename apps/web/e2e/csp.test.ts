// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from '@playwright/test';

test.describe('Content Security Policy', () => {
  test('serves strict CSP header', async ({ request }) => {
    const response = await request.get('/');
    const csp = response.headers()['content-security-policy'];

    expect(csp).toBeDefined();
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).toContain("require-trusted-types-for 'script'");
  });

  test('inline script injection is blocked', async ({ page }) => {
    await page.goto('/');

    // Attempt inline script injection — blocked by Trusted Types (throws on
    // script.textContent assignment) or CSP (blocks execution after append).
    await page
      .evaluate(() => {
        try {
          const script = document.createElement('script');
          script.textContent = 'window.__csp_test_executed = true';
          document.body.appendChild(script);
        } catch {
          // Trusted Types policy blocked the assignment — expected
        }
      })
      .catch(() => {
        // Some browsers propagate the Trusted Types error to page.evaluate
      });

    const wasExecuted = await page.evaluate(
      () => (window as Record<string, unknown>)['__csp_test_executed'],
    );
    expect(wasExecuted).toBeUndefined();
  });
});
