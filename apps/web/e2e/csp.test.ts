// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from '@playwright/test';

test.describe('Content Security Policy', () => {
  test('serves strict CSP header via API proxy', async ({ request }) => {
    const response = await request.get('http://localhost:3001/health');
    const csp = response.headers()['content-security-policy'];

    expect(csp).toBeDefined();
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).toContain("require-trusted-types-for 'script'");
  });

  test('inline script injection is blocked by CSP', async ({ page }) => {
    const cspViolations: string[] = [];

    page.on('console', (msg) => {
      if (msg.text().includes('securitypolicyviolation')) {
        cspViolations.push(msg.text());
      }
    });

    await page.goto('/');

    const blocked = await page.evaluate(() => {
      return new Promise<boolean>((resolve) => {
        document.addEventListener('securitypolicyviolation', () => {
          resolve(true);
        });

        const script = document.createElement('script');
        script.textContent = 'window.__csp_test_executed = true';
        document.body.appendChild(script);

        setTimeout(() => resolve(false), 500);
      });
    });

    expect(blocked).toBe(true);

    const wasExecuted = await page.evaluate(
      () => (window as Record<string, unknown>)['__csp_test_executed'],
    );
    expect(wasExecuted).toBeUndefined();
  });
});
