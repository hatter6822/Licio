// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ReactNode } from 'react';
import { cn } from '../../../lib/cn.js';
import { Tooltip } from '../../ui/Tooltip/index.js';

export interface DefinedTermProps {
  /** The jargon/term shown inline. */
  term: ReactNode;
  /** The plain-language definition surfaced on hover/focus. */
  definition: ReactNode;
  className?: string;
}

/**
 * A defined term (WS-B.2.13 / Section 26.3). Renders a term with a plain-
 * language definition exposed through the accessible Tooltip (hover, keyboard
 * focus, and — because the trigger is a real button — tap on touch devices).
 */
export function DefinedTerm({ term, definition, className }: DefinedTermProps): React.ReactElement {
  return (
    <Tooltip content={definition}>
      <button
        type="button"
        className={cn(
          // tap-target gives this small inline control a ≥48×48 activation area
          // (WS-B.1.1e) without enlarging the visual text.
          'tap-target cursor-help rounded-sm underline decoration-dotted decoration-from-font underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
          className,
        )}
      >
        {term}
      </button>
    </Tooltip>
  );
}
