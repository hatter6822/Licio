// SPDX-License-Identifier: AGPL-3.0-or-later
import { type ReactNode, useId, useState } from 'react';
import { useT } from '../../../i18n/index.js';
import { cn } from '../../../lib/cn.js';
import { Button } from '../../ui/Button/index.js';
import { Icon } from '../../ui/Icon/index.js';

export interface TranslationDisclosureProps {
  /** The (possibly machine-translated) content shown by default. */
  children: ReactNode;
  /** The original-language content, revealed via "view original". */
  original: ReactNode;
  /** BCP-47 language tag of the original, applied as `lang` (WCAG 3.1.2). */
  originalLang: string;
  /** Whether the content is machine-translated. When false, renders children
   * plainly with no badge (nothing to disclose). Default true. */
  translated?: boolean;
  className?: string;
}

/**
 * Translation disclosure (WS-B.2.14 / Section 26.4). Machine-translated content
 * is labelled with a clear badge, and the user can toggle to the original text
 * — which carries its own `lang` attribute so assistive tech announces it in the
 * correct language (WCAG 3.1.2, Language of Parts). A user must always be able
 * to tell when content was machine-translated and reach the source text.
 */
export function TranslationDisclosure({
  children,
  original,
  originalLang,
  translated = true,
  className,
}: TranslationDisclosureProps): React.ReactElement {
  const t = useT();
  const regionId = useId();
  const [showingOriginal, setShowingOriginal] = useState(false);

  if (!translated) {
    return <div className={className}>{children}</div>;
  }

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1 rounded-full bg-info-soft px-2 py-0.5 text-xs font-medium text-info-on-soft">
          <Icon name="globe" className="size-3.5" />
          <span>{t('translation.badge', 'Machine-translated')}</span>
        </span>
        <Button
          variant="ghost"
          aria-pressed={showingOriginal}
          aria-controls={regionId}
          onClick={() => setShowingOriginal((v) => !v)}
        >
          {showingOriginal
            ? t('translation.viewTranslation', 'View translation')
            : t('translation.viewOriginal', 'View original')}
        </Button>
      </div>
      <div id={regionId}>
        {showingOriginal ? (
          // The original keeps its own language so screen readers switch voices.
          <div lang={originalLang}>{original}</div>
        ) : (
          children
        )}
      </div>
    </div>
  );
}
