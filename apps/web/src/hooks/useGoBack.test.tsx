// SPDX-License-Identifier: AGPL-3.0-or-later
//
// useGoBack drives every detail-page header back button.  These tests exercise
// it inside a REAL (memory-history) router so the retrace / cold-fallback
// behaviour is proven against the actual history stack, not a mock.
//
// The regression it guards: a header "back" that HARD-NAVIGATES (pushes) to a
// fixed parent ping-pongs with the parent's own history-back button (front →
// story → comments, then comments-back pushes a second story, story-back pops
// to comments, forever).  useGoBack must instead POP real history (never grow
// the stack on back), and on a cold load must REPLACE (never push) so a deep
// link cannot re-enter that loop either.
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  useNavigate,
} from '@tanstack/react-router';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useGoBack } from './useGoBack.js';

// Three param-free REGISTERED app paths, so the `navigate({ to })` fallback
// typechecks against the real router while the route tree here uses trivial
// stubs.  The cold-load fallback REPLACES (matching every real call site).
function BackStub({ label, to }: { label: string; to: '/' | '/rooms' }): React.ReactElement {
  const navigate = useNavigate();
  const goBack = useGoBack(() => void navigate({ to, replace: true }));
  return (
    <div>
      <p>{label}</p>
      <button type="button" onClick={goBack}>
        Go back
      </button>
    </div>
  );
}

function makeRouter(initialEntries: string[]) {
  const rootRoute = createRootRoute({ component: Outlet });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => <p>front page</p>,
  });
  const roomsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/rooms',
    component: () => <BackStub label="rooms list" to="/" />,
  });
  const profileRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/profile',
    component: () => <BackStub label="detail page" to="/rooms" />,
  });
  return createRouter({
    routeTree: rootRoute.addChildren([indexRoute, roomsRoute, profileRoute]),
    history: createMemoryHistory({ initialEntries }),
  });
}

describe('useGoBack', () => {
  it('retraces real history on back and never grows the stack (no loop)', async () => {
    const router = makeRouter(['/']);
    render(<RouterProvider router={router as never} />);

    // front → rooms → detail (two genuine pushes).
    await router.navigate({ to: '/rooms' });
    await screen.findByText('rooms list');
    await router.navigate({ to: '/profile' });
    await screen.findByText('detail page');
    const depth = router.history.length;
    expect(depth).toBe(3);

    // Detail back → POP to the rooms list, WITHOUT pushing a fixed parent.
    fireEvent.click(screen.getByRole('button', { name: /go back/i }));
    await screen.findByText('rooms list');
    // A push-based "back" would have grown the stack to 4 (the loop); a pop keeps it.
    expect(router.history.length).toBe(depth);

    // Rooms back → POP to the front page. Still no growth.
    fireEvent.click(screen.getByRole('button', { name: /go back/i }));
    await screen.findByText('front page');
    expect(router.history.length).toBe(depth);
  });

  it('falls back to the canonical parent by REPLACING on a cold load', async () => {
    // Cold load straight onto the detail page: nothing to pop (index 0).
    const router = makeRouter(['/profile']);
    render(<RouterProvider router={router as never} />);
    await screen.findByText('detail page');
    expect(router.history.length).toBe(1);

    fireEvent.click(screen.getByRole('button', { name: /go back/i }));
    await screen.findByText('rooms list');
    // Replace, not push: the synthetic parent takes the single existing entry's
    // place, so it can never become a forward-loopable child.
    await waitFor(() => expect(router.history.length).toBe(1));
  });
});
