import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

test('renders the secure PWA shell without accessibility violations', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Licio' })).toBeVisible();
  const accessibilityScanResults = await new AxeBuilder({ page }).analyze();
  expect(accessibilityScanResults.violations).toEqual([]);
});

test('enforces strict CSP against inline script execution in a real browser', async ({ page }) => {
  const cspViolations: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' && message.text().includes('Content Security Policy')) {
      cspViolations.push(message.text());
    }
  });

  await page.goto('/');
  const injectionError = await page
    .evaluate(() => {
      const script = document.createElement('script');
      script.textContent = 'window.__licioInlineScriptExecuted = true';
      document.body.append(script);
    })
    .then(
      () => undefined,
      (error: Error) => error.message,
    );

  await expect.poll(() => page.evaluate(() => window.__licioInlineScriptExecuted)).toBeUndefined();
  expect(injectionError ?? cspViolations.join('\n')).toMatch(
    /Content Security Policy|TrustedScript|blocked by CSP|Raw scripts are never permitted/,
  );
});

test('emits the strict CSP and Trusted Types directives from the preview server', async ({
  page,
}) => {
  const response = await page.goto('/');
  const csp = response?.headers()['content-security-policy'];
  expect(csp).toContain("script-src 'self'");
  expect(csp).toContain("require-trusted-types-for 'script'");
  expect(csp).not.toContain('unsafe-inline');
  expect(csp).not.toContain('unsafe-eval');
});
