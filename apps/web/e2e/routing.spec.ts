// SPDX-License-Identifier: AGPL-3.0-or-later
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

// The repo-standard tag set (comments/content-room/search/composer/ugc-safety/
// design-system all use exactly this list). WCAG 2.2 AA is a SUPERSET of 2.1
// AA, so a scan named "WCAG 2.2 AA" that omits `wcag21aa` never even LOADS the
// 2.1 rules: measured against the pinned axe-core 4.12.1, adding the tag back
// registers `autocomplete-valid` (1.3.5) and `avoid-inline-spacing` (1.4.12).
const A11Y_TAGS = ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'];

// This suite runs against the frontend-only preview, where `/v1/*` falls
// through to `server.proxy` → :3001 and nothing listens, so every API call
// 502s.  Route stubs are the only way a scan here sees product content — and a
// CONTROLLING service worker would own those requests before `page.route`
// could (its `/v1` NetworkFirst handler), so block it, exactly as
// search.spec.ts does for the same reason.
test.use({ serviceWorkers: 'block' });

const PUBLIC_ROOM_ID = '5f5e2000-0000-4000-8000-000000000001';
const PRIVATE_ROOM_ID = '5f5e2000-0000-4000-8000-000000000002';

/**
 * Stub `GET /v1/rooms` with a page the client will actually RENDER.
 *
 * The items must satisfy `roomListResponseSchema` — uuid `room_id`, the §16.2
 * `join_model`/`posting_policy` axes, `governance_mode`, the descriptive
 * counts — because every response is zod-parsed before it reaches the query
 * cache: a stub that fails validation drops the page to ErrorState, which
 * recreates the very blind spot the stub exists to close.
 *
 * A RegExp rather than a glob because hono's client requests `/v1/rooms?`
 * (trailing `?` for the empty query), and the anchored `(\?|$)` keeps the stub
 * off the room DETAIL route (`/v1/rooms/<id>`), which this test never wants.
 */
async function stubRooms(page: Page): Promise<void> {
  await page.route(/\/v1\/rooms(\?|$)/, (route) =>
    route.fulfill({
      json: {
        items: [
          {
            room_id: PUBLIC_ROOM_ID,
            name: 'Watershed Monitoring',
            slug: 'watershed-monitoring',
            room_type: 'global_topic',
            visibility: 'public',
            join_model: 'open',
            posting_policy: 'all_members',
            description: 'Reservoir and river telemetry, from the primary sources.',
            thread_count: 12,
            member_count: 340,
            latest_activity_at: '2026-07-03T09:00:00.000Z',
            governance_mode: 'ordinary',
            joined: false,
            can_post: true,
            created_at: '2026-05-01T00:00:00.000Z',
          },
          {
            // A private room too: its "Private room" badge is the one piece of
            // this list's markup that renders on no other scanned surface.
            room_id: PRIVATE_ROOM_ID,
            name: 'Transit Working Group',
            slug: 'transit-working-group',
            room_type: 'professional_domain',
            visibility: 'private',
            join_model: 'request_approval',
            posting_policy: 'experts_and_stewards',
            description: null,
            thread_count: 3,
            member_count: 9,
            latest_activity_at: null,
            governance_mode: 'ordinary',
            joined: true,
            can_post: false,
            created_at: '2026-06-11T00:00:00.000Z',
          },
        ],
        nextCursor: null,
      },
    }),
  );
}

test.describe('routing (WS-C.1.1)', () => {
  test('navigates the primary tabs client-side with aria-current', async ({ page }) => {
    await page.goto('/');
    // Tag the window; a full-page reload would clear it, so its persistence
    // proves navigation was client-side (no reload).
    await page.evaluate(() => {
      (window as unknown as { __spa: boolean }).__spa = true;
    });

    const roomsTab = page.getByRole('link', { name: 'Rooms' }).first();
    await roomsTab.click();
    await expect(page).toHaveURL(/\/rooms$/);
    await expect(roomsTab).toHaveAttribute('aria-current', 'page');

    const stillSpa = await page.evaluate(
      () => (window as unknown as { __spa?: boolean }).__spa === true,
    );
    expect(stillSpa).toBe(true);

    await page.getByRole('link', { name: 'Front Page' }).first().click();
    await expect(page).toHaveURL(/\/(\?.*)?$/);
  });

  test('redirects an auth-guarded route to login', async ({ page }) => {
    await page.goto('/profile');
    await expect(page).toHaveURL(/\/login/);
  });

  test('redirects the legacy governance route to the room governance deep link', async ({
    page,
  }) => {
    // WS-U §24.6 (L7): the room-governance surface is now a modal ON the room page.
    // The legacy /rooms/:id/governance route no longer renders an inert
    // "unavailable" stub — it redirects to the room with the governance modal
    // deep-linked open (?governance=<tab>).
    await page.goto('/rooms/11111111-1111-4111-8111-111111111111/governance');
    await expect(page).toHaveURL(
      /\/rooms\/11111111-1111-4111-8111-111111111111\?governance=overview/,
    );
    await expect(page.getByText(/Governance features are not enabled/i)).toHaveCount(0);
  });

  test('renders a not-found state inside the shell for an unknown path', async ({ page }) => {
    await page.goto('/this-route-does-not-exist');
    // The catch-all renders IN PLACE — it never silently redirects to `/`,
    // which would destroy the deep-link error affordance.
    await expect(page).toHaveURL(/this-route-does-not-exist/);
    // The not-found state itself. Asserting only the shell nav below would be
    // satisfied by literally every route in the application, so the heading +
    // recovery link are what actually pin this route's behaviour.
    await expect(page.getByRole('heading', { name: /page not found/i })).toBeVisible();
    await expect(page.getByRole('heading', { name: /we couldn't find that page/i })).toBeVisible();
    await expect(page.getByRole('link', { name: /go to the front page/i })).toBeVisible();
    // The bottom navigation (app shell) is still present — not a hard 404 page.
    await expect(page.getByRole('navigation', { name: /Primary navigation/i })).toBeVisible();
  });

  test('passes WCAG 2.2 AA checks on the Rooms route', async ({ page }) => {
    await stubRooms(page);
    await page.goto('/rooms');
    await expect(page.locator('main h1')).toBeVisible();
    // Scan the room LIST, not the "Loading…" skeleton the unstubbed preview
    // leaves behind: without this precondition axe judges a heading and a
    // spinner, and a room card that lost its accessible name would ship green.
    await expect(page.getByRole('link', { name: /Watershed Monitoring/ })).toBeVisible();
    await expect(page.getByText('Private room')).toBeVisible();
    const results = await new AxeBuilder({ page }).withTags(A11Y_TAGS).analyze();
    expect(results.violations).toEqual([]);
  });
});
