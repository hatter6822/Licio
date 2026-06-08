// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SwipeableStoryCard (WS-B.2.2). A pointer-gesture layer wrapped AROUND the
// existing StoryCard — StoryCard is imported and rendered unchanged, so its
// always-present Save / Context / More buttons remain the keyboard and single-
// pointer alternative (WCAG 2.1.1, 2.5.1). The swipe is a shortcut, never the
// only way to act.
//
// Gesture → result map (physical directions, per spec):
//   swipe left  → onSave
//   swipe right → onOpenContext
//   long-press  → onMore
//
// The gesture MATH is physical (clientX deltas) so "left" means left for every
// reader. The VISUAL follow-the-finger transform is driven by a `--swipe-x` CSS
// custom property set imperatively on the surface (no JSX inline `style`, per
// the design-system rule) and consumed by a `translate-x-[var(--swipe-x)]`
// utility. Under prefers-reduced-motion the hook keeps `offset` at 0, so the
// variable stays 0px and the transform collapses to none — only the motion is
// removed, the action still fires.
import { type ReactElement, useEffect, useRef } from 'react';
import { cn } from '../../../lib/cn.js';
import { StoryCard, type StoryCardProps } from '../StoryCard/index.js';
import { type StoryCardSwipeOptions, useStoryCardSwipe } from './useStoryCardSwipe.js';

export interface SwipeableStoryCardProps
  extends StoryCardProps,
    Pick<StoryCardSwipeOptions, 'swipeThreshold' | 'longPressMs'> {
  /** Optional class for the gesture surface (not the inner card). */
  wrapperClassName?: string;
}

export function SwipeableStoryCard({
  swipeThreshold,
  longPressMs,
  wrapperClassName,
  className,
  ...storyCardProps
}: SwipeableStoryCardProps): ReactElement {
  const { onSave, onOpenContext, onMore } = storyCardProps;
  const surfaceRef = useRef<HTMLDivElement | null>(null);

  const { handlers, offset, dragging } = useStoryCardSwipe({
    ...(onSave ? { onSave } : {}),
    ...(onOpenContext ? { onOpenContext } : {}),
    ...(onMore ? { onMore } : {}),
    ...(swipeThreshold !== undefined ? { swipeThreshold } : {}),
    ...(longPressMs !== undefined ? { longPressMs } : {}),
  });

  // Reflect the signed px offset onto a CSS custom property (positive = toward
  // the end edge, negative = toward the start edge). Done imperatively so the
  // JSX carries no inline `style` attribute.
  useEffect(() => {
    surfaceRef.current?.style.setProperty('--swipe-x', `${offset}px`);
  }, [offset]);

  return (
    // The surface is purely decorative/gestural: it exposes no role and no
    // tabindex, so AT and keyboard users go straight to the card's buttons.
    <div
      ref={surfaceRef}
      {...handlers}
      className={cn(
        'touch-pan-y',
        offset !== 0 && 'translate-x-[var(--swipe-x)]',
        dragging ? 'transition-none' : 'transition-transform duration-fast ease-out',
        wrapperClassName,
      )}
    >
      <StoryCard {...storyCardProps} className={cn(className)} />
    </div>
  );
}
