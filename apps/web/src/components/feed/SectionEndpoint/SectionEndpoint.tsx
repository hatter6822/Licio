// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Section endpoint (WS-B.2.8a). The calm "you are caught up" marker rendered at
// the end of a feed section. It is a deliberate full stop: it renders NOTHING
// below itself and never triggers an automatic load of more content — continuing
// is always an explicit, opt-in choice. The optional action is intentionally
// low-emphasis (a ghost Button), so reaching the end never nags the reader into
// fetching more. The block is a polite live region so assistive tech hears that
// the section has ended. A gentle mount fade-in (neutralised under
// prefers-reduced-motion at the token + base layer) softens its appearance.
import { useEffect, useState } from 'react';
import { useT } from '../../../i18n/index.js';
import { cn } from '../../../lib/cn.js';
import { Button } from '../../ui/Button/index.js';
import { Icon } from '../../ui/Icon/index.js';

export interface SectionEndpointAction {
  /** Visible, descriptive button label. */
  label: string;
  /** Invoked on activation. */
  onAction: () => void;
}

export interface SectionEndpointProps {
  /** Endpoint message. Defaults to "You're all caught up". */
  message?: string;
  /** Optional low-emphasis follow-up (rendered as a ghost Button). */
  action?: SectionEndpointAction;
  className?: string;
}

/**
 * End-of-section marker. Announces (politely) that the reader has reached the
 * end and exposes nothing below — there is no infinite scroll here. Any further
 * content is the reader's explicit choice via the optional ghost action.
 */
export function SectionEndpoint({
  message,
  action,
  className,
}: SectionEndpointProps): React.ReactElement {
  const t = useT();
  const resolvedMessage = message ?? t('sectionendpoint.message', "You're all caught up");

  // Gentle fade-in on mount: start transparent, settle to full opacity on the
  // next frame. The duration is zeroed under prefers-reduced-motion (token +
  // base layer), so reduced-motion readers simply see it appear.
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(id);
  }, []);

  return (
    // `<output>` carries an implicit `role="status"` (a polite live region), so
    // reaching the end of the section is announced without an explicit ARIA role.
    <output
      className={cn(
        'flex flex-col items-center justify-center gap-3 px-6 py-10 text-center transition-opacity duration-normal ease-out',
        entered ? 'opacity-100' : 'opacity-0',
        className,
      )}
    >
      <Icon name="check-circle" className="size-8 text-ink-muted" />
      <span className="text-sm font-medium text-ink">{resolvedMessage}</span>
      {action ? (
        <Button variant="ghost" onClick={action.onAction}>
          {action.label}
        </Button>
      ) : null}
    </output>
  );
}
