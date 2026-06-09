// SPDX-License-Identifier: AGPL-3.0-or-later
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { useT } from '../../../i18n/index.js';
import { checkA11y } from '../../../test/axe.js';
import { AppShell } from '../AppShell/index.js';
import { BottomNav, defaultNavItems } from '../BottomNav/index.js';
import { PageHeader } from '../PageHeader/index.js';
import { SafeArea } from '../SafeArea/index.js';
import { ScrollArea } from '../ScrollArea/index.js';

function Nav({ activeId }: { activeId?: string }) {
  const t = useT();
  return <BottomNav items={defaultNavItems(t)} {...(activeId !== undefined ? { activeId } : {})} />;
}

describe('BottomNav (WS-B.1.5)', () => {
  it('renders five labelled tabs with icons and text (never icon-only)', () => {
    render(<Nav activeId="front-page" />);
    const nav = screen.getByRole('navigation', { name: 'Primary navigation' });
    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(5);
    for (const label of ['Front Page', 'Rooms', 'Submit', 'Threads', 'Profile']) {
      expect(screen.getByRole('link', { name: new RegExp(label) })).toBeInTheDocument();
    }
    // Each link contains both an icon (svg) and a visible text label.
    expect(nav.querySelectorAll('svg')).toHaveLength(5);
  });

  it('marks the active tab with aria-current="page"', () => {
    render(<Nav activeId="rooms" />);
    expect(screen.getByRole('link', { name: /Rooms/ })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: /Profile/ })).not.toHaveAttribute('aria-current');
  });

  it('colours the prominent Submit tab with a canvas-accessible token (≥4.5:1 in dark mode)', () => {
    render(<Nav />);
    // `text-primary` is only ~3.3:1 on the dark canvas; the prominent tab must use
    // `text-primary-on-soft` (verified ≥4.5:1 on the canvas in both modes).
    const submit = screen.getByRole('link', { name: /Submit/ });
    const classes = submit.className.split(/\s+/);
    expect(classes).toContain('text-primary-on-soft');
    expect(classes).not.toContain('text-primary');
  });
});

describe('AppShell (WS-B.1.5)', () => {
  it('exposes header/main/nav landmarks, a focusable main, and a skip link first', () => {
    render(
      <AppShell nav={<Nav />} banner={<div>Licio</div>}>
        <PageHeader title="Front Page" />
        <p>Body</p>
      </AppShell>,
    );
    expect(screen.getByRole('banner')).toBeInTheDocument();
    const main = document.getElementById('main');
    expect(main?.tagName).toBe('MAIN');
    expect(main).toHaveAttribute('tabindex', '-1');
    expect(screen.getByRole('navigation', { name: 'Primary navigation' })).toBeInTheDocument();
    // Skip link is the first focusable element and targets #main.
    const skip = screen.getByRole('link', { name: 'Skip to content' });
    expect(skip).toHaveAttribute('href', '#main');
  });

  it('has no axe violations as a full shell', async () => {
    const { container } = render(
      <AppShell nav={<Nav activeId="front-page" />}>
        <PageHeader title="Front Page" />
        <p>Body content</p>
      </AppShell>,
    );
    expect(await checkA11y(container)).toHaveNoViolations();
  });
});

describe('PageHeader (WS-B.1.5)', () => {
  it('renders the page <h1> and an optional back button', async () => {
    const user = userEvent.setup();
    const onBack = vi.fn();
    render(
      <PageHeader title="Thread" onBack={onBack} actions={<button type="button">Share</button>} />,
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Thread' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Go back' }));
    expect(onBack).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Share' })).toBeInTheDocument();
  });
});

describe('ScrollArea + SafeArea (WS-B.1.5)', () => {
  it('exposes a labelled, focusable scroll region', () => {
    render(
      <ScrollArea label="Story feed">
        <p>Rows</p>
      </ScrollArea>,
    );
    const region = screen.getByRole('region', { name: 'Story feed' });
    expect(region).toHaveAttribute('tabindex', '0');
  });

  it('applies physical safe-area padding for the chosen sides', () => {
    const { container } = render(
      <SafeArea sides={['top', 'bottom']}>
        <p>Content</p>
      </SafeArea>,
    );
    const el = container.firstElementChild;
    expect(el?.className).toContain('pt-[env(safe-area-inset-top)]');
    expect(el?.className).toContain('pb-[env(safe-area-inset-bottom)]');
  });
});
