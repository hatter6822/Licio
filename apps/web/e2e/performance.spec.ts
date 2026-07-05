// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Interaction-budget release gate (WS-C.5.1, SPEC §6.10). WS-T retired the
// branch reader and the comment-filter tabs, so the browser budget now exercises
// opening the comment composer's inline "Add source" sub-form on a story page —
// an always-present control, independent of fetched comment content. The preview
// server serves static assets only; API reads are stubbed at the network layer
// and the service worker is blocked so the stub is deterministic.
import { expect, test } from '@playwright/test';

const STORY = '5f5e1000-0000-4000-8000-000000000001';
const THREAD = '5f5e2000-0000-4000-8000-000000000001';
const COMMENT_INTERACTION_BUDGET_MS = 500;

test.use({ serviceWorkers: 'block' });

test.describe('interaction budgets (WS-C.5.1)', () => {
  test('opening the composer’s Add-source sub-form stays within the 500ms budget', async ({
    page,
  }) => {
    await page.route('**/v1/feature-flags', async (route) => {
      await route.fulfill({ json: { flags: {} } });
    });
    await page.route('**/v1/security/link-blocklist', async (route) => {
      await route.fulfill({ json: { blocked: [] } });
    });
    await page.route('**/v1/auth/status', async (route) => {
      await route.fulfill({ json: { authenticated: false, user: null } });
    });
    await page.route('**/v1/settings', async (route) => {
      await route.fulfill({ json: {} });
    });
    await page.route('**/v1/telemetry', async (route) => {
      await route.fulfill({ status: 204 });
    });
    await page.route(`**/v1/stories/${STORY}`, async (route) => {
      await route.fulfill({
        json: {
          story_id: STORY,
          title: 'Regional water board publishes the full testing dataset',
          source: 'Public Records Office',
          origin: 'official',
          url: 'https://example.org/water-testing-dataset',
          reading_minutes: 6,
          rating_label: 'well-sourced',
          exposure_label: null,
          more_on_this_story: [],
          context_card: null,
          distribution_reason: 'Readers opened the source and added context.',
          context_chips: [],
          safety_state: 'ok',
          body_summary: 'The board released raw and processed results alongside the methodology.',
          thread_id: THREAD,
          topic_ids: ['water-quality'],
        },
      });
    });
    await page.route(`**/v1/stories/${STORY}/interpretations`, async (route) => {
      await route.fulfill({ json: { interpretations: [] } });
    });
    await page.route(`**/v1/stories/${STORY}/independent-sources`, async (route) => {
      await route.fulfill({ json: { sources: [] } });
    });
    await page.route(`**/v1/stories/${STORY}/comments**`, async (route) => {
      await route.fulfill({
        json: {
          comments: [],
          next_cursor: null,
          overview: { comment_count: 0, sources_count: 0, corrections_count: 0 },
        },
      });
    });
    await page.route(`**/v1/stories/${STORY}/debates`, async (route) => {
      await route.fulfill({ json: { debates: [] } });
    });

    await page.goto(`/stories/${STORY}`);
    await expect(page.getByRole('region', { name: 'Conversation' })).toBeVisible();

    const addSourceButton = page.getByRole('button', { name: 'Add source' });
    await expect(addSourceButton).toBeVisible();
    const duration = await addSourceButton.evaluate((button) => {
      const started = performance.now();
      (button as HTMLButtonElement).click();
      return new Promise<number>((resolve) => {
        requestAnimationFrame(() => {
          resolve(performance.now() - started);
        });
      });
    });
    await expect(page.getByRole('textbox', { name: /source url/i })).toBeVisible();
    expect(duration).toBeGreaterThanOrEqual(0);
    expect(duration).toBeLessThanOrEqual(COMMENT_INTERACTION_BUDGET_MS);
  });
});
