// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Attachment affordance (WS-B.2.11). A labelled file input preceded by a privacy
// warning (metadata in files can deanonymize), and an accessible list of the
// attached files. Each entry has a remove button whose accessible name includes
// the filename, so screen-reader users can tell the controls apart.
import { useId, useRef, useState } from 'react';
import { useT } from '../../../i18n/index.js';
import { cn } from '../../../lib/cn.js';
import { Button } from '../../ui/Button/index.js';
import { Icon } from '../../ui/Icon/index.js';
import { PrivacyWarning } from './PrivacyWarning.js';

export interface AttachmentProps {
  /** Receives the current list of attached files on every add/remove. */
  onFilesChange?: (files: File[]) => void;
  /** `accept` attribute forwarded to the native input (e.g. "image/*"). */
  accept?: string;
  /** Allow selecting more than one file at a time. */
  multiple?: boolean;
  className?: string;
}

export function Attachment({
  onFilesChange,
  accept,
  multiple = false,
  className,
}: AttachmentProps): React.ReactElement {
  const t = useT();
  const inputId = useId();
  const statusId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);

  const update = (next: File[]): void => {
    setFiles(next);
    onFilesChange?.(next);
  };

  const handleChange = (): void => {
    const selected = inputRef.current?.files;
    if (!selected || selected.length === 0) {
      return;
    }
    update([...files, ...Array.from(selected)]);
    // Reset the native input so re-selecting the same file still fires `change`.
    if (inputRef.current) {
      inputRef.current.value = '';
    }
  };

  const remove = (index: number): void => {
    update(files.filter((_, i) => i !== index));
  };

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <PrivacyWarning>
        {t(
          'composer.attach.privacy',
          'Files can carry hidden metadata (location, device, author). Review attachments before sharing.',
        )}
      </PrivacyWarning>

      <div className="flex flex-col gap-1">
        <label htmlFor={inputId} className="text-sm font-medium text-ink">
          {t('composer.attach.label', 'Attach a file')}
        </label>
        <input
          ref={inputRef}
          id={inputId}
          type="file"
          accept={accept}
          multiple={multiple}
          onChange={handleChange}
          className="block w-full text-sm text-ink file:me-3 file:min-h-touch file:rounded-md file:border file:border-line-strong file:bg-surface file:px-4 file:py-2 file:text-sm file:font-medium file:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        />
      </div>

      {files.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {files.map((file, index) => (
            <li
              key={`${file.name}-${index}`}
              className="flex min-h-touch items-center justify-between gap-2 rounded-md border border-line bg-surface px-3 py-1"
            >
              <span className="flex min-w-0 items-center gap-2 text-sm text-ink">
                <Icon name="paperclip" className="size-4 shrink-0 text-ink-muted" />
                <span className="truncate">{file.name}</span>
              </span>
              <Button
                type="button"
                iconOnly
                variant="ghost"
                aria-label={t('composer.attach.remove', 'Remove {name}', { name: file.name })}
                onClick={() => remove(index)}
              >
                <Icon name="x" className="size-4" />
              </Button>
            </li>
          ))}
        </ul>
      ) : null}

      {/* Announce add/remove so the file list stays perceivable without sight. */}
      <p id={statusId} className="sr-only" aria-live="polite">
        {t('composer.attach.count', '{count} file(s) attached', { count: files.length })}
      </p>
    </div>
  );
}
