// SPDX-License-Identifier: AGPL-3.0-or-later
//
// MarkdownEditor — a doctrine-safe "rich text" composer (WS-Q.5.2a).  Licio's
// UGC pipeline is Markdown-lite → renderUGC → DOMPurify (`licio-ugc`) → the ONE
// sanctioned sink, so there is deliberately NO contentEditable / WYSIWYG surface
// (that would mint HTML and bypass the single sanctioned UGC sink, a review-
// blocking violation).  Instead this pairs a large, auto-growing plain-text
// field with a formatting toolbar that inserts Markdown-lite syntax and a
// Write/Preview toggle whose preview renders through the SAME `UgcBody` sink the
// reader will see — so what the author writes is exactly what ships.
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useT } from '../../../i18n/index.js';
import { cn } from '../../../lib/cn.js';
import { UgcBody } from '../../ugc/UgcBody.js';
import { Icon, type IconName } from '../../ui/Icon/index.js';

export interface MarkdownEditorProps {
  /** Field label (rendered as the group's accessible name). */
  label: string;
  value: string;
  onChange: (value: string) => void;
  id?: string;
  required?: boolean;
  error?: string;
  helperText?: string;
  placeholder?: string;
  /** Character limit (enables the live-announced count + native input cap). */
  maxLength?: number;
  /** A shorter authoring surface for dense contexts (e.g. a comment composer). */
  compact?: boolean;
}

/** Fraction of the limit at which the count starts warning (mirrors TextArea). */
const APPROACHING = 0.9;

interface ToolbarButton {
  id: string;
  icon: IconName;
  label: string;
  apply: 'bold' | 'italic' | 'quote' | 'list' | 'link';
  /** The shortcut key (paired with the platform mod key), for the tooltip. */
  shortcut?: string;
}

const editorField =
  // The authoring surface grows with its content (`field-sizing:content`,
  // JS-autosized where unsupported) between a min and a scrollable max height set
  // per `compact`. `neu-inset` recesses the field into the fabric (WS-B theme).
  'block w-full resize-y rounded-b-md border border-t-0 bg-canvas px-3 py-2 text-base text-ink neu-inset transition-colors [field-sizing:content] overflow-auto focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus';

export function MarkdownEditor({
  label,
  value,
  onChange,
  id,
  required = false,
  error,
  helperText,
  placeholder,
  maxLength,
  compact = false,
}: MarkdownEditorProps): React.ReactElement {
  const t = useT();
  const generatedId = useId();
  const fieldId = id ?? generatedId;
  const labelId = `${fieldId}-label`;
  const errorId = `${fieldId}-error`;
  const helperId = `${fieldId}-helper`;
  const countId = `${fieldId}-count`;
  const [tab, setTab] = useState<'write' | 'preview'>('write');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // A selection to restore AFTER the controlled value commits (a toolbar action
  // rewrites `value`, so the caret must be re-placed on the next render).
  const pendingSelection = useRef<[number, number] | null>(null);

  const buttons = useMemo<ToolbarButton[]>(
    () => [
      { id: 'bold', icon: 'bold', label: t('markdown.bold', 'Bold'), apply: 'bold', shortcut: 'B' },
      {
        id: 'italic',
        icon: 'italic',
        label: t('markdown.italic', 'Italic'),
        apply: 'italic',
        shortcut: 'I',
      },
      { id: 'quote', icon: 'quote', label: t('markdown.quote', 'Quote'), apply: 'quote' },
      { id: 'list', icon: 'list', label: t('markdown.list', 'Bulleted list'), apply: 'list' },
      { id: 'link', icon: 'link', label: t('markdown.link', 'Link'), apply: 'link', shortcut: 'K' },
    ],
    [t],
  );

  // The platform's PRIMARY formatting modifier — ⌘ on Apple, Ctrl elsewhere —
  // drives BOTH the live shortcut handler and its tooltip so they never diverge.
  // Gating the handler on ⌘ (not Ctrl) on macOS is what keeps Ctrl-based Cocoa
  // text bindings (Ctrl+K deletes to end of line, Ctrl+B steps the caret back)
  // working there.
  const isApplePlatform = useMemo(
    () =>
      typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/i.test(navigator.userAgent ?? ''),
    [],
  );
  const shortcutMod = isApplePlatform ? '⌘' : 'Ctrl+';

  // Progressive enhancement for the auto-grow (mirrors the UI TextArea): where
  // CSS `field-sizing` is supported the browser handles it; otherwise fall back
  // to a scrollHeight-driven grow. CSSOM height assignment is CSP-safe.
  const supportsFieldSizing = useMemo(
    () =>
      typeof CSS !== 'undefined' &&
      typeof CSS.supports === 'function' &&
      CSS.supports('field-sizing', 'content'),
    [],
  );
  function autosize(): void {
    if (supportsFieldSizing) return;
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }

  // Restore the caret after a toolbar action's controlled re-render, and keep the
  // fallback autosize in step with external value changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `value` re-runs this after a controlled update
  useEffect(() => {
    autosize();
    const sel = pendingSelection.current;
    const el = textareaRef.current;
    if (sel && el) {
      pendingSelection.current = null;
      el.focus();
      el.setSelectionRange(sel[0], sel[1]);
    }
  }, [value]);

  /** Commit a rewritten value + the caret range to restore once it renders. */
  function commit(next: string, selStart: number, selEnd: number): void {
    if (maxLength !== undefined && next.length > maxLength) return;
    pendingSelection.current = [selStart, selEnd];
    onChange(next);
  }

  function surround(before: string, after: string, ph: string): void {
    const el = textareaRef.current;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    const selected = value.slice(start, end) || ph;
    const next = `${value.slice(0, start)}${before}${selected}${after}${value.slice(end)}`;
    const selStart = start + before.length;
    commit(next, selStart, selStart + selected.length);
  }

  function prefixLines(prefix: string, ph: string): void {
    const el = textareaRef.current;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    const lineStart = value.lastIndexOf('\n', start - 1) + 1;
    const nextNewline = value.indexOf('\n', end);
    const lineEnd = nextNewline === -1 ? value.length : nextNewline;
    const existing = value.slice(lineStart, lineEnd);
    const block = existing || ph;
    const prefixed = block
      .split('\n')
      .map((line) => `${prefix}${line}`)
      .join('\n');
    const next = `${value.slice(0, lineStart)}${prefixed}${value.slice(lineEnd)}`;
    // Empty line → placeholder inserted: select ONLY the placeholder (after the
    // marker) so typing over it replaces the placeholder while KEEPING the
    // '- '/'> ' formatting — mirroring surround(), where the markers stay outside
    // the restored selection. A real (non-empty) block selects the whole prefixed
    // block so the reader sees exactly what was reformatted.
    if (existing.length === 0) {
      commit(next, lineStart + prefix.length, lineStart + prefix.length + ph.length);
    } else {
      commit(next, lineStart, lineStart + prefixed.length);
    }
  }

  function applyFormat(kind: ToolbarButton['apply']): void {
    switch (kind) {
      case 'bold':
        surround('**', '**', t('markdown.ph.bold', 'bold text'));
        break;
      case 'italic':
        surround('*', '*', t('markdown.ph.italic', 'italic text'));
        break;
      case 'quote':
        prefixLines('> ', t('markdown.ph.quote', 'quote'));
        break;
      case 'list':
        prefixLines('- ', t('markdown.ph.list', 'list item'));
        break;
      case 'link':
        surround('[', '](https://)', t('markdown.ph.link', 'link text'));
        break;
    }
  }

  // Standard rich-text keyboard shortcuts (⌘/Ctrl + B / I / K). Only the
  // platform's PRIMARY modifier triggers formatting — ⌘ on Apple, Ctrl elsewhere
  // — so macOS's Ctrl-based Cocoa text bindings survive; Alt-modified combos
  // (OS/word-nav chords) are always left alone.
  function onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>): void {
    const primaryHeld = isApplePlatform ? event.metaKey : event.ctrlKey;
    if (!primaryHeld || event.altKey) return;
    const key = event.key.toLowerCase();
    if (key === 'b') {
      event.preventDefault();
      applyFormat('bold');
    } else if (key === 'i') {
      event.preventDefault();
      applyFormat('italic');
    } else if (key === 'k') {
      event.preventDefault();
      applyFormat('link');
    }
  }

  const current = value.length;
  let liveMessage = '';
  let nearLimit = false;
  if (maxLength !== undefined) {
    if (current >= maxLength) {
      liveMessage = t('textarea.limitReached', 'Character limit reached.');
      nearLimit = true;
    } else if (current >= Math.floor(maxLength * APPROACHING)) {
      liveMessage = t(
        'textarea.charactersRemaining',
        '{count, plural, one {# character remaining.} other {# characters remaining.}}',
        { count: maxLength - current },
      );
      nearLimit = true;
    }
  }

  const describedBy =
    cn(
      error ? errorId : undefined,
      helperText ? helperId : undefined,
      maxLength !== undefined ? countId : undefined,
    ) || undefined;
  const isEmpty = value.trim().length === 0;

  const tabButton =
    'min-h-touch rounded-md px-3 py-1 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus';

  return (
    <div className="flex flex-col gap-1" role="group" aria-labelledby={labelId}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        {/* The aria-labelledby target is the inner span holding only the label
            wording: an aria-labelledby reference INCLUDES hidden nodes (accname
            spec), so the decorative asterisk must sit OUTSIDE it or a screen
            reader would announce it as "star". */}
        <span className="text-sm font-medium text-ink">
          <span id={labelId}>{label}</span>
          {required ? (
            <span className="ms-0.5 text-error-on-soft" aria-hidden="true">
              *
            </span>
          ) : null}
        </span>
        {/* Write / Preview toggle. */}
        <div
          className="inline-flex gap-1 rounded-md bg-surface p-0.5"
          role="group"
          aria-label={t('markdown.mode', 'Editor mode')}
        >
          <button
            type="button"
            aria-pressed={tab === 'write'}
            onClick={() => setTab('write')}
            className={cn(
              tabButton,
              tab === 'write' ? 'bg-canvas text-ink neu-raised-sm' : 'text-ink-muted',
            )}
          >
            {t('markdown.write', 'Write')}
          </button>
          <button
            type="button"
            aria-pressed={tab === 'preview'}
            onClick={() => setTab('preview')}
            className={cn(
              tabButton,
              tab === 'preview' ? 'bg-canvas text-ink neu-raised-sm' : 'text-ink-muted',
            )}
          >
            {t('markdown.preview', 'Preview')}
          </button>
        </div>
      </div>

      <div className="flex flex-col">
        {/* Formatting toolbar — only meaningful while writing. */}
        {tab === 'write' ? (
          <div
            role="toolbar"
            aria-label={t('markdown.toolbar', 'Text formatting')}
            aria-controls={fieldId}
            className="flex flex-wrap items-center gap-0.5 rounded-t-md border border-b-0 border-line-strong bg-surface px-1.5 py-1"
          >
            {buttons.map((button) => (
              <button
                key={button.id}
                type="button"
                aria-label={button.label}
                title={
                  button.shortcut
                    ? `${button.label} (${shortcutMod}${button.shortcut})`
                    : button.label
                }
                onClick={() => applyFormat(button.apply)}
                className="inline-flex size-8 items-center justify-center rounded text-ink-muted transition-colors hover:bg-canvas hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
              >
                <Icon name={button.icon} className="size-4" />
              </button>
            ))}
          </div>
        ) : null}

        {/* The textarea stays mounted (value + label association persist); it is
            hidden — not unmounted — while previewing. */}
        <textarea
          ref={textareaRef}
          id={fieldId}
          value={value}
          hidden={tab === 'preview'}
          required={required}
          {...(maxLength !== undefined ? { maxLength } : {})}
          placeholder={
            placeholder ?? t('markdown.placeholder', 'Write your text… Markdown is supported.')
          }
          onChange={(event) => {
            onChange(event.currentTarget.value);
            autosize();
          }}
          onKeyDown={onKeyDown}
          aria-labelledby={labelId}
          aria-required={required || undefined}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={cn(
            editorField,
            compact ? 'max-h-64 min-h-28' : 'max-h-[32rem] min-h-48',
            error && 'border-error',
          )}
        />

        {tab === 'preview' ? (
          <div
            className={cn(
              'rounded-md border border-line-strong bg-canvas p-3 neu-inset',
              compact ? 'min-h-28' : 'min-h-48',
              isEmpty && 'text-ink-muted',
            )}
          >
            {isEmpty ? (
              <p className="text-sm">{t('markdown.previewEmpty', 'Nothing to preview yet.')}</p>
            ) : (
              <UgcBody markdown={value} />
            )}
          </div>
        ) : null}
      </div>

      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-col gap-1">
          {helperText ? (
            <p id={helperId} className="text-sm text-ink-muted">
              {helperText}
            </p>
          ) : null}
          {error ? (
            <p id={errorId} className="flex items-center gap-1 text-sm text-error-on-soft">
              <Icon name="octagon-exclamation" className="size-4" />
              <span>{error}</span>
            </p>
          ) : null}
        </div>
        {maxLength !== undefined ? (
          <p
            id={countId}
            className={cn(
              'shrink-0 text-sm tabular-nums',
              nearLimit ? 'text-warning-on-soft' : 'text-ink-muted',
              current >= maxLength && 'text-error-on-soft',
            )}
          >
            <span aria-hidden="true">
              {current} / {maxLength}
            </span>
            <span className="sr-only" aria-live="polite">
              {liveMessage}
            </span>
          </p>
        ) : null}
      </div>
    </div>
  );
}
