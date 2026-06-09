// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Interaction-budget release gate (WS-C.5.1, SPEC §6.10). The app emits User
// Timing measures (`licio:<interaction>`) for the budgeted interactions; this
// asserts the measured duration is within budget in a real browser. The thread
// branch-open budget is ≤500ms (cached). Composer-open (≤300ms) and draft-save
// (≤100ms) live behind the auth guard and are covered by the perf unit tests.
import { expect, test } from '@playwright/test';

// A demo thread (served by the in-memory BFF fixture) with multiple branches.
const THREAD = '5f5e2000-0000-4000-8000-000000000001';
const BRANCH_OPEN_BUDGET_MS = 500;

test.describe('interaction budgets (WS-C.5.1)', () => {
  test('opening a thread branch stays within the 500ms budget', async ({ page }) => {
    await page.goto(`/threads/${THREAD}`);

    // The branch bar is a tablist; switching branches times a branch-open.
    await page.getByRole('tab', { name: 'Evidence' }).click();

    // The measure is recorded when the branch content resolves.
    const handle = await page.waitForFunction(() => {
      const entries = performance.getEntriesByName('licio:branch-open', 'measure');
      return entries.length > 0 ? (entries[entries.length - 1]?.duration ?? null) : null;
    });
    const duration = (await handle.jsonValue()) as number;
    expect(duration).toBeGreaterThanOrEqual(0);
    expect(duration).toBeLessThanOrEqual(BRANCH_OPEN_BUDGET_MS);
  });
});
