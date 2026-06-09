// SPDX-License-Identifier: AGPL-3.0-or-later
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { checkA11y } from '../../test/axe.js';
import { RouteAnnouncer } from './RouteAnnouncer.js';
import { SkipToContent } from './SkipToContent.js';
import { focusMainHeading, useSpaFocus } from './useSpaFocus.js';

describe('SkipToContent', () => {
  it('is a link targeting the main landmark, hidden until focused', () => {
    render(<SkipToContent />);
    const link = screen.getByRole('link', { name: 'Skip to content' });
    expect(link).toHaveAttribute('href', '#main');
    expect(link).toHaveClass('sr-only');
  });

  it('has no axe violations', async () => {
    const { container } = render(<SkipToContent />);
    expect(await checkA11y(container)).toHaveNoViolations();
  });
});

describe('focusMainHeading', () => {
  it('focuses the <h1> inside <main> and makes it programmatically focusable', () => {
    render(
      <main id="main">
        <h1>Front Page</h1>
      </main>,
    );
    focusMainHeading();
    const heading = screen.getByRole('heading', { level: 1, name: 'Front Page' });
    expect(heading).toHaveFocus();
    expect(heading).toHaveAttribute('tabindex', '-1');
  });

  it('falls back to the <main> landmark when there is no <h1>', () => {
    render(<main id="main">No heading</main>);
    focusMainHeading();
    expect(document.getElementById('main')).toHaveFocus();
  });
});

function RouteView({ routeKey, title }: { routeKey: string; title: string }) {
  useSpaFocus(routeKey, title);
  return (
    <main id="main">
      <h1>{title}</h1>
    </main>
  );
}

function RouterHarness() {
  const [route, setRoute] = useState({ key: '/', title: 'Front Page' });
  return (
    <RouteAnnouncer>
      <button type="button" onClick={() => setRoute({ key: '/rooms', title: 'Rooms' })}>
        Go to Rooms
      </button>
      <RouteView routeKey={route.key} title={route.title} />
    </RouteAnnouncer>
  );
}

describe('useSpaFocus + RouteAnnouncer (WS-B.1.6)', () => {
  it('on route change, focuses the new <h1> and announces the title assertively', async () => {
    const user = userEvent.setup();
    render(<RouterHarness />);

    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1, name: 'Front Page' })).toHaveFocus();
    });

    await user.click(screen.getByRole('button', { name: 'Go to Rooms' }));

    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1, name: 'Rooms' })).toHaveFocus();
    });
    const liveRegion = document.querySelector('[aria-live="assertive"]');
    await waitFor(() => {
      expect(liveRegion).toHaveTextContent('Rooms');
    });
  });
});
