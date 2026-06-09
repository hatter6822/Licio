// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Error state (WS-B.2.5). Surfaces a failed fetch/operation with an assertive
// announcement (`role="alert"`) and an optional primary Retry action. The error
// icon is paired with text (colour/icon is never the sole carrier of meaning),
// and the message is announced immediately to assistive tech.
import { useT } from '../../../i18n/index.js';
import { cn } from '../../../lib/cn.js';
import { Button } from '../Button/index.js';
import { Icon } from '../Icon/index.js';

export interface ErrorStateProps {
  /** Heading text. Defaults to a generic "Something went wrong". */
  title?: string;
  /** Supporting detail. Defaults to a generic retry hint. */
  description?: string;
  /** When provided, renders a primary Retry button that calls this handler. */
  onRetry?: () => void;
  /** Heading level so the state fits its surrounding hierarchy. */
  headingLevel?: 2 | 3 | 4;
  className?: string;
}

/**
 * Assertive error placeholder. The whole block is `role="alert"`, so the title
 * and description are announced as soon as it mounts; an optional Retry button
 * (the `refresh` icon) lets the user re-run the failed operation.
 */
export function ErrorState({
  title,
  description,
  onRetry,
  headingLevel = 2,
  className,
}: ErrorStateProps): React.ReactElement {
  const t = useT();
  const Heading = `h${headingLevel}` as 'h2' | 'h3' | 'h4';

  const resolvedTitle = title ?? t('errorstate.title', 'Something went wrong');
  const resolvedDescription =
    description ?? t('errorstate.description', 'We could not load this. Please try again.');

  return (
    // Assertive live region: announce the failure immediately (it interrupts).
    <div
      role="alert"
      className={cn(
        'flex flex-col items-center justify-center gap-3 px-6 py-12 text-center',
        className,
      )}
    >
      <Icon name="octagon-exclamation" className="size-10 text-error-on-soft" />
      <Heading className="text-lg font-semibold text-ink">{resolvedTitle}</Heading>
      <p className="max-w-prose text-sm text-ink-muted">{resolvedDescription}</p>
      {onRetry ? (
        <Button variant="primary" onClick={onRetry} className="mt-1">
          <Icon name="refresh" className="size-4" />
          {t('errorstate.retry', 'Retry')}
        </Button>
      ) : null}
    </div>
  );
}
