// SPDX-License-Identifier: AGPL-3.0-or-later
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkA11y } from '../../../test/axe.js';
import type { StoryCardData } from '../types.js';
import { SwipeableStoryCard } from './SwipeableStoryCard.js';

const sample: StoryCardData = {
  story: {
    id: 's1',
    title: 'River levels stabilize after upstream coordination',
    source: 'Delta Observer',
    origin: 'independent',
    url: 'https://example.org/story',
    readingMinutes: 4,
  },
  ratingLabel: 'deepening',
  distributionReason: 'Rising from independent source opens and sourced comments',
};

/** Drive a synthetic swipe across the gesture surface. */
function swipe(el: Element, from: { x: number; y: number }, to: { x: number; y: number }): void {
  fireEvent.touchStart(el, { touches: [{ clientX: from.x, clientY: from.y }] });
  fireEvent.touchMove(el, { touches: [{ clientX: to.x, clientY: to.y }] });
  fireEvent.touchEnd(el, { changedTouches: [{ clientX: to.x, clientY: to.y }] });
}

/** The card markup is wrapped in the gesture surface (its parent <div>). */
function surfaceOf(article: Element): HTMLElement {
  const parent = article.parentElement;
  if (!parent) throw new Error('expected a gesture surface around the card');
  return parent;
}

describe('SwipeableStoryCard gesture → action map (WS-B.2.2)', () => {
  it('left swipe fires onSave', () => {
    const onSave = vi.fn();
    render(<SwipeableStoryCard {...sample} onSave={onSave} />);
    const surface = surfaceOf(screen.getByRole('article'));
    // Physical leftward travel well past the 64px threshold.
    swipe(surface, { x: 200, y: 100 }, { x: 100, y: 104 });
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('right swipe fires onOpenContext', () => {
    const onOpenContext = vi.fn();
    render(<SwipeableStoryCard {...sample} onOpenContext={onOpenContext} />);
    const surface = surfaceOf(screen.getByRole('article'));
    swipe(surface, { x: 100, y: 100 }, { x: 200, y: 96 });
    expect(onOpenContext).toHaveBeenCalledTimes(1);
  });

  it('does NOT fire on a mostly-vertical move (lets scroll pass)', () => {
    const onSave = vi.fn();
    const onOpenContext = vi.fn();
    render(<SwipeableStoryCard {...sample} onSave={onSave} onOpenContext={onOpenContext} />);
    const surface = surfaceOf(screen.getByRole('article'));
    // |dy| (120) > |dx| (70): a vertical scroll, not a horizontal swipe.
    swipe(surface, { x: 100, y: 60 }, { x: 170, y: 180 });
    expect(onSave).not.toHaveBeenCalled();
    expect(onOpenContext).not.toHaveBeenCalled();
  });

  it('does NOT fire when horizontal travel is below the threshold', () => {
    const onSave = vi.fn();
    const onOpenContext = vi.fn();
    render(<SwipeableStoryCard {...sample} onSave={onSave} onOpenContext={onOpenContext} />);
    const surface = surfaceOf(screen.getByRole('article'));
    // 40px < 64px threshold.
    swipe(surface, { x: 100, y: 100 }, { x: 140, y: 102 });
    expect(onSave).not.toHaveBeenCalled();
    expect(onOpenContext).not.toHaveBeenCalled();
  });
});

describe('SwipeableStoryCard long-press (WS-B.2.2)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('long-press (~500ms, stationary) fires onMore', () => {
    const onMore = vi.fn();
    render(<SwipeableStoryCard {...sample} onMore={onMore} />);
    const surface = surfaceOf(screen.getByRole('article'));
    fireEvent.touchStart(surface, { touches: [{ clientX: 100, clientY: 100 }] });
    vi.advanceTimersByTime(500);
    expect(onMore).toHaveBeenCalledTimes(1);
    fireEvent.touchEnd(surface, { changedTouches: [{ clientX: 100, clientY: 100 }] });
  });

  it('a drag cancels the pending long-press (does not fire onMore)', () => {
    const onMore = vi.fn();
    const onSave = vi.fn();
    render(<SwipeableStoryCard {...sample} onMore={onMore} onSave={onSave} />);
    const surface = surfaceOf(screen.getByRole('article'));
    fireEvent.touchStart(surface, { touches: [{ clientX: 200, clientY: 100 }] });
    // Move beyond the long-press tolerance before the timer elapses.
    fireEvent.touchMove(surface, { touches: [{ clientX: 120, clientY: 102 }] });
    vi.advanceTimersByTime(500);
    expect(onMore).not.toHaveBeenCalled();
    fireEvent.touchEnd(surface, { changedTouches: [{ clientX: 100, clientY: 102 }] });
    // The completed leftward drag still resolves to Save.
    expect(onSave).toHaveBeenCalledTimes(1);
  });
});

describe('SwipeableStoryCard reduced motion + keyboard alternative', () => {
  const original = window.matchMedia;
  afterEach(() => {
    window.matchMedia = original;
  });

  it('under prefers-reduced-motion the action still fires (no transform offset)', () => {
    window.matchMedia = ((query: string) => ({
      matches: query.includes('reduce'),
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;

    const onOpenContext = vi.fn();
    render(<SwipeableStoryCard {...sample} onOpenContext={onOpenContext} />);
    const surface = surfaceOf(screen.getByRole('article'));
    swipe(surface, { x: 100, y: 100 }, { x: 200, y: 100 });
    // Action fires …
    expect(onOpenContext).toHaveBeenCalledTimes(1);
    // … but no follow-the-finger transform was applied (offset stayed 0).
    expect(surface.className).not.toContain('translate-x-');
  });

  it("exposes StoryCard's buttons as the keyboard alternative", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    const onOpenContext = vi.fn();
    const onMore = vi.fn();
    render(
      <SwipeableStoryCard
        {...sample}
        onSave={onSave}
        onOpenContext={onOpenContext}
        onMore={onMore}
      />,
    );
    await user.click(screen.getByRole('button', { name: /Save/ }));
    await user.click(screen.getByRole('button', { name: /Context/ }));
    await user.click(screen.getByRole('button', { name: /More actions/ }));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onOpenContext).toHaveBeenCalledTimes(1);
    expect(onMore).toHaveBeenCalledTimes(1);
  });

  it('has no axe violations (the wrapped card)', async () => {
    const { container } = render(
      <SwipeableStoryCard {...sample} onSave={() => undefined} onOpenContext={() => undefined} />,
    );
    expect(await checkA11y(container)).toHaveNoViolations();
  });
});
