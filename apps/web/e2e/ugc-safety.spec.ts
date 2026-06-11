// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Real-browser verification of the WS-G.4 UGC pipeline, run against the
// styleguide fixtures under the preview server's REAL Content-Security-Policy
// (`trusted-types default dompurify licio-ugc; require-trusted-types-for
// 'script'`).  This covers what jsdom cannot: the licio-ugc Trusted Types
// policy creating TrustedHTML under enforcement, real-engine sanitization of
// the attack fixtures (mXSS is parser-dependent), and the WS-G.4.2c
// interstitial's click interception with genuine user activation.
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

async function gotoStyleguide(page: Page): Promise<void> {
  await page.goto('/styleguide');
  await expect(page.getByRole('heading', { level: 1, name: 'Component workbench' })).toBeVisible();
}

test.describe('UGC pipeline under real Trusted Types enforcement', () => {
  test('the preview serves the enforcing CSP (the assumption this suite rests on)', async ({
    page,
  }) => {
    const response = await page.goto('/styleguide');
    const csp = response?.headers()['content-security-policy'] ?? '';
    expect(csp).toContain("require-trusted-types-for 'script'");
    expect(csp).toContain('trusted-types default dompurify licio-ugc');
  });

  test('renders formatted UGC through the licio-ugc policy in a real engine', async ({ page }) => {
    await gotoStyleguide(page);
    const sample = page.getByTestId('ugc-formatting');
    await expect(sample.getByRole('heading', { name: 'Reservoir levels' })).toBeVisible();
    await expect(sample.locator('strong')).toHaveText('May reading');
    await expect(sample.locator('blockquote')).toContainText('Quoted from the gauge log.');
    await expect(sample.getByRole('link', { name: 'agency report' })).toHaveAttribute(
      'rel',
      /noopener/,
    );
  });

  test('attack payloads come out inert: no script, no handlers, no javascript: URLs', async ({
    page,
  }) => {
    await gotoStyleguide(page);
    const attack = page.getByTestId('ugc-attack');
    await expect(attack).toBeVisible();
    // The payloads never executed (the window flag was never set)…
    expect(await page.evaluate(() => (window as { __ugc_xss?: boolean }).__ugc_xss)).toBe(
      undefined,
    );
    // …and the DOM carries no executable remnants.
    expect(await attack.locator('script').count()).toBe(0);
    expect(await attack.locator('img').count()).toBe(0);
    expect(await attack.locator('[onerror], [onclick], [onload]').count()).toBe(0);
    expect(await attack.locator('a[href^="javascript:"]').count()).toBe(0);
    // The javascript: link was de-fanged at parse time (text survives, no href).
    await expect(attack.getByText('harmless?')).toBeVisible();
  });

  test('a suspicious link opens the interstitial; Back closes without navigating', async ({
    page,
    context,
  }) => {
    await gotoStyleguide(page);
    const attack = page.getByTestId('ugc-attack');
    let popupOpened = false;
    context.on('page', () => {
      popupOpened = true;
    });
    await attack.getByRole('link', { name: 'claim airdrop' }).click();
    await expect(page.getByText('https://site.example/approve?spender=0xabc123')).toBeVisible();
    await page.getByRole('button', { name: /go back/i }).click();
    await expect(page.getByText('https://site.example/approve?spender=0xabc123')).not.toBeVisible();
    expect(popupOpened).toBe(false);
  });

  test('a safe link opens in a new tab with user activation intact', async ({ page }) => {
    await gotoStyleguide(page);
    const sample = page.getByTestId('ugc-formatting');
    const popupPromise = page.waitForEvent('popup');
    await sample.getByRole('link', { name: 'agency report' }).click();
    // The popup EVENT is the assertion: window.open ran under intact user
    // activation (a popup-blocked open would never fire it).  The window is
    // noopener and the sandbox has no route to example.org, so the popup's
    // final URL is not meaningful here.
    const popup = await popupPromise;
    expect(popup).toBeTruthy();
    // The interstitial did not appear for a safe destination.
    await expect(page.getByText('https://example.org/report')).not.toBeVisible();
  });

  test('the UGC section has zero axe violations', async ({ page }) => {
    await gotoStyleguide(page);
    const results = await new AxeBuilder({ page })
      .include('[data-testid="ugc-formatting"]')
      .include('[data-testid="ugc-attack"]')
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
});
