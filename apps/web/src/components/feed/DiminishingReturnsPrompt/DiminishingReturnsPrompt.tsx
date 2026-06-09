// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Diminishing-returns prompt (WS-B.2.8b). The gate between the high-confidence
// endpoint of a feed section and the lower-confidence / more-repetitive content
// beyond it. Crossing that boundary is ALWAYS an explicit, informed choice: the
// reader must press the continue Button — nothing loads from scrolling. The
// prompt states plainly why the next items are weaker, so the decision is
// informed rather than nudged. It is rendered as an `<output>` (implicit
// role="status"), so its title + explanation are announced politely on appear.
import { useT } from '../../../i18n/index.js';
import { cn } from '../../../lib/cn.js';
import { Button } from '../../ui/Button/index.js';
import { Icon } from '../../ui/Icon/index.js';

export interface DiminishingReturnsPromptProps {
  /** Why the next items are weaker. Defaults to a confidence/repetition note. */
  explanation?: string;
  /** Optional emphasised lead-in for the prompt. Defaults to "Fewer strong matches". */
  title?: string;
  /** Override the continue button label. */
  continueLabel?: string;
  /** Invoked ONLY when the reader explicitly chooses to continue. */
  onContinue: () => void;
  className?: string;
}

/**
 * Explicit "show lower-confidence content" gate. Renders an explanation and a
 * single deliberate Button; the lower-confidence content below is never fetched
 * or revealed until {@link DiminishingReturnsPromptProps.onContinue} fires from a
 * real activation. There is intentionally no scroll-triggered behaviour.
 */
export function DiminishingReturnsPrompt({
  explanation,
  title,
  continueLabel,
  onContinue,
  className,
}: DiminishingReturnsPromptProps): React.ReactElement {
  const t = useT();

  const resolvedTitle = title ?? t('diminishingreturns.title', 'Fewer strong matches');
  const resolvedExplanation =
    explanation ??
    t('diminishingreturns.explanation', 'The next items are lower confidence or more repetitive.');
  const resolvedContinueLabel =
    continueLabel ?? t('diminishingreturns.continue', 'Show lower-confidence stories');

  return (
    // `<output>` has an implicit `role="status"` (a polite live region): when the
    // prompt appears, its title + explanation are announced without interrupting.
    // Everything inside is phrasing content; the lower-confidence content beyond
    // is revealed ONLY by the explicit continue Button — never by scrolling.
    <output
      className={cn(
        'flex flex-col items-center gap-3 rounded-lg border border-line border-dashed bg-surface px-6 py-8 text-center',
        className,
      )}
    >
      <Icon name="circle-info" className="size-7 text-ink-muted" />
      <span className="text-base font-semibold text-ink">{resolvedTitle}</span>
      <span className="max-w-prose text-sm text-ink-muted">{resolvedExplanation}</span>
      <Button variant="secondary" onClick={onContinue} className="mt-1">
        {resolvedContinueLabel}
      </Button>
    </output>
  );
}
