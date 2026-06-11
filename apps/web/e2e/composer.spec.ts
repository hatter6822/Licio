// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Real-browser verification of the WS-G.3 Participation Composer, run
// against the styleguide workbench (the demo wires onSubmit to the REAL
// shared-schema payload builder, so validation behavior here is exactly the
// /submit page's).  Covers what jsdom approximates: the grouped 11-mode
// chooser in a real engine, schema-driven required-field errors, the
// WS-G.3.6b acknowledgment-gates-submit rule, and axe on every state.
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

async function gotoComposer(page: Page): Promise<void> {
  await page.goto('/styleguide');
  await expect(page.getByRole('heading', { name: 'Participation composer' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'What are you adding?' })).toBeVisible();
}

test.describe('participation composer (WS-G.3.4–3.6)', () => {
  test('offers all five groups and eleven typed modes — no generic comment', async ({ page }) => {
    await gotoComposer(page);
    const chooser = page.getByRole('group');
    for (const mode of [
      'Ask',
      'Answer',
      'Evidence',
      'Correction',
      'Synthesis',
      'Counterexample',
      'Explain',
      'Local context',
      'Experience',
      'Flag',
      'Meta',
    ]) {
      await expect(chooser.getByRole('button', { name: new RegExp(`^${mode}:`) })).toBeVisible();
    }
    await expect(page.getByRole('button', { name: /comment/i })).toHaveCount(0);
  });

  test('schema-driven validation: an empty Ask submit reports the required field', async ({
    page,
  }) => {
    await gotoComposer(page);
    await page.getByRole('button', { name: /^Ask:/ }).click();
    await page.getByRole('button', { name: 'Add contribution' }).click();
    await expect(page.getByText(/required/i).first()).toBeVisible();
  });

  test('the direct-experience acknowledgment gates submit (WS-G.3.6b)', async ({ page }) => {
    await gotoComposer(page);
    await page.getByRole('button', { name: /^Experience:/ }).click();
    const submit = page.getByRole('button', { name: 'Add contribution' });
    await expect(submit).toBeDisabled();
    // The native input is visually hidden behind a styled overlay — click
    // the visible label, exactly as a user would.
    await page.getByText(/I understand/i).click();
    await expect(page.getByRole('checkbox', { name: /I understand/i })).toBeChecked();
    await expect(submit).toBeEnabled();
  });

  test('a valid question round-trips the shared schema (success toast)', async ({ page }) => {
    await gotoComposer(page);
    await page.getByRole('button', { name: /^Ask:/ }).click();
    await page
      .getByRole('textbox', { name: /question/i })
      .first()
      .fill('What evidence supports the employment claim?');
    await page.getByRole('button', { name: 'Add contribution' }).click();
    await expect(page.getByText('Validated against the shared schema')).toBeVisible();
  });

  test('the composer has zero axe violations in chooser and mode states', async ({ page }) => {
    await gotoComposer(page);
    const tags = ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'];
    const chooser = await new AxeBuilder({ page }).withTags(tags).analyze();
    expect(chooser.violations).toEqual([]);
    await page.getByRole('button', { name: /^Evidence:/ }).click();
    // Let the chip's `transition-colors` settle before sampling colors —
    // axe reads mid-transition blends otherwise (a sampling artifact, not a
    // steady-state contrast failure: white on primary is 5.7:1).  The
    // pointer parks at the origin first so the hover style clears too.
    await page.mouse.move(0, 0);
    await expect(page.getByRole('button', { name: /^Evidence:/ })).toHaveCSS(
      'background-color',
      'rgb(31, 95, 214)',
    );
    const mode = await new AxeBuilder({ page }).withTags(tags).analyze();
    expect(mode.violations).toEqual([]);
  });
});
