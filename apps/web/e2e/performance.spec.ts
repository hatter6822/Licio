// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Interaction-budget release gate (WS-C.5.1, SPEC §6.10). The app emits User
// Timing measures (`licio:<interaction>`) for the budgeted interactions; this
// asserts the measured duration is within budget in a real browser. The thread
// branch-open budget is ≤500ms (cached). Composer-open (≤300ms) and draft-save
// (≤100ms) live behind the auth guard and are covered by the perf unit tests.
//
// The preview server serves only static assets (no BFF), so the thread + branch
// reads are stubbed at the network layer; the service worker is blocked so the
// stub is the deterministic source (no NetworkFirst cache interplay).
import { expect, test } from '@playwright/test';

const THREAD = '5f5e2000-0000-4000-8000-000000000001';
const STORY = '5f5e1000-0000-4000-8000-000000000001';
const BRANCH_OPEN_BUDGET_MS = 500;

test.use({ serviceWorkers: 'block' });

test.describe('interaction budgets (WS-C.5.1)', () => {
  test('opening a thread branch stays within the 500ms budget', async ({ page }) => {
    // Fixtures match the WS-G wire schemas exactly — the page zod-validates
    // every response before it enters the cache (the WS-C.1.2 boundary).
    await page.route(/\/v1\/threads\//, async (route) => {
      const branch = new URL(route.request().url()).pathname.match(/\/branches\/([^/?]+)/)?.[1];
      if (branch) {
        await route.fulfill({
          json: {
            thread_id: THREAD,
            branch,
            contributions: [
              {
                contribution_id: '5f5e4000-0000-4000-8000-000000000001',
                thread_id: THREAD,
                type: 'evidence',
                body: 'A primary source worth weighing.',
                citations: [{ url: 'https://example.org/source' }],
                metadata: {},
                target_claim_id: null,
                parent_contribution_id: null,
                author_handle: 'ada',
                author_display_name: 'Ada',
                is_author: false,
                depth: 0,
                child_count: 0,
                moderation_state: 'published',
                edited: false,
                created_at: '2026-06-09T12:30:00.000Z',
                updated_at: '2026-06-09T12:30:00.000Z',
              },
            ],
            next_cursor: null,
          },
        });
        return;
      }
      await route.fulfill({
        json: {
          thread_id: THREAD,
          story_id: STORY,
          room_id: null,
          branch_index: 0,
          title: 'A deliberative thread',
          conversation_state: 'active',
          safety_state: 'normal',
          contribution_count: 1,
          created_at: '2026-06-09T12:00:00.000Z',
          updated_at: '2026-06-09T12:30:00.000Z',
          sections: {
            overview: 0,
            questions: 0,
            evidence: 1,
            challenges: 0,
            lenses: 0,
            chronology: 1,
          },
          summary_status: 'none',
          current_summary: null,
          summary_layers: [],
        },
      });
    });

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
