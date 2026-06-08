// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Citation capture affordance (WS-B.2.11). Accepts a shared URL or text selection
// (via `initialUrl`) and turns it into an EDITABLE citation: the value is
// prefilled into an Input the user can correct before inserting. Manual paste
// works with no Web Share involvement — the field is a plain text input, so the
// capture path and the paste path are identical. The captured citation is
// announced politely on insert.
import { useEffect, useId, useState } from 'react';
import { useT } from '../../../i18n/index.js';
import { cn } from '../../../lib/cn.js';
import { Button } from '../../ui/Button/index.js';
import { Icon } from '../../ui/Icon/index.js';
import { Input } from '../../ui/Input/index.js';

export interface CitationCaptureProps {
  /** A URL/selection captured from a share target; prefills the editable field. */
  initialUrl?: string;
  /** Receives the final (possibly edited) citation text when the user inserts. */
  onInsert?: (citation: string) => void;
  className?: string;
}

export function CitationCapture({
  initialUrl,
  onInsert,
  className,
}: CitationCaptureProps): React.ReactElement {
  const t = useT();
  const statusId = useId();
  const [value, setValue] = useState(initialUrl ?? '');
  const [inserted, setInserted] = useState('');

  // Keep the editable field in sync when a new share arrives, without clobbering
  // edits to an unchanged prop (effect only re-runs when initialUrl changes).
  useEffect(() => {
    if (initialUrl !== undefined) {
      setValue(initialUrl);
    }
  }, [initialUrl]);

  const handleInsert = (): void => {
    const trimmed = value.trim();
    if (!trimmed) {
      return;
    }
    onInsert?.(trimmed);
    setInserted(trimmed);
  };

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <Input
        label={t('composer.citation.label', 'Citation')}
        helperText={t(
          'composer.citation.help',
          'Paste a link or edit the captured reference before inserting.',
        )}
        inputMode="url"
        value={value}
        onChange={(event) => setValue(event.target.value)}
      />

      <div>
        <Button type="button" variant="secondary" onClick={handleInsert}>
          <Icon name="quote" className="size-4" />
          {t('composer.citation.insert', 'Insert citation')}
        </Button>
      </div>

      {/* Announce the inserted citation so screen-reader users get confirmation. */}
      <p id={statusId} className="sr-only" aria-live="polite">
        {inserted
          ? t('composer.citation.inserted', 'Citation inserted: {citation}', {
              citation: inserted,
            })
          : ''}
      </p>
    </div>
  );
}
