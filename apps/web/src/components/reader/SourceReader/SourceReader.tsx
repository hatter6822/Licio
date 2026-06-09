// SPDX-License-Identifier: AGPL-3.0-or-later
//
// In-app sandboxed Source Reader (WS-B.2.7). Lets a reader open an external
// source without leaving the thread and without trusting that source's scripts.
//
// Threat model & defenses:
//   - The external page is shown in an <iframe sandbox=""> — an EMPTY sandbox is
//     the maximally restrictive setting. It grants NONE of allow-scripts,
//     allow-same-origin, allow-forms, allow-popups or allow-top-navigation, so
//     the framed document cannot run JS, read same-origin data, submit forms,
//     spawn popups, or navigate this parent window.
//   - "Readability mode" swaps that iframe for `readabilityHtml`, which is
//     PRE-SANITIZED upstream (DOMPurify on the API boundary). We never inject it
//     as raw HTML here: we render it as plain React text split into paragraphs,
//     so even a sanitizer regression cannot execute markup in this component.
//   - Citation capture reads the user's current selection (or a typed excerpt)
//     into an editable field, then hands a {url,text} citation to the caller.
//
// Focus management: while open the reader is a focus trap (shared
// `useFocusTrap`), so Tab stays within it and Escape / the Back button restore
// focus to whatever element opened the reader (the thread).
import DOMPurify from 'dompurify';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { useFocusTrap } from '../../../hooks/useFocusTrap.js';
import { useT } from '../../../i18n/index.js';
import { cn } from '../../../lib/cn.js';
import { Button } from '../../ui/Button/index.js';
import { Icon } from '../../ui/Icon/index.js';
import { type ReadableContent, extractReadable } from './readability.js';

/**
 * Extract readable content from sanitized HTML, off the main thread where a Web
 * Worker is available (browsers) and on the main thread otherwise (tests/SSR).
 * Both paths run the same pure `extractReadable`.
 */
async function runReadability(safeHtml: string): Promise<ReadableContent> {
  if (typeof Worker !== 'undefined') {
    try {
      const worker = new Worker(new URL('./readability.worker.ts', import.meta.url), {
        type: 'module',
      });
      const result = await new Promise<ReadableContent>((resolve, reject) => {
        worker.addEventListener('message', (event: MessageEvent<ReadableContent>) =>
          resolve(event.data),
        );
        worker.addEventListener('error', () => reject(new Error('readability worker failed')));
        worker.postMessage(safeHtml);
      });
      worker.terminate();
      return result;
    } catch {
      // Fall back to the main thread.
    }
  }
  return extractReadable(safeHtml);
}

export interface SourceCitation {
  /** The source URL the excerpt was captured from. */
  url: string;
  /** The captured (editable) excerpt text. */
  text: string;
}

export interface SourceReaderProps {
  /** External source URL loaded in the sandboxed iframe. */
  url: string;
  /** Human-readable source title (iframe `title` + reader heading). */
  title: string;
  /** Return to the thread; focus is restored to the opener. */
  onClose: () => void;
  /** Receive a captured, edited citation. Omit to hide the capture affordance. */
  onCaptureCitation?: (citation: SourceCitation) => void;
  /**
   * Raw source HTML for readability mode. It is DOMPurify-sanitized and then the
   * main content is extracted (in a Web Worker where available) into structured
   * TEXT, rendered through React — never injected as markup.
   */
  sourceHtml?: string;
  /**
   * Pre-extracted plain text for readability mode (alternative to `sourceHtml`).
   * Rendered as TEXT split into paragraphs. When neither is set, readability mode
   * is unavailable.
   */
  readabilityHtml?: string;
  className?: string;
}

/**
 * Split already-sanitized readability text into paragraph nodes. We treat the
 * input as plain text (blank lines = paragraph breaks) and render each block as
 * a React child, so nothing in it is ever interpreted as markup.
 */
function renderReadabilityParagraphs(text: string): ReactNode {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0);

  if (paragraphs.length === 0) return null;

  return paragraphs.map((paragraph, index) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: paragraphs are positional, identity-less text blocks
    <p key={index} className="text-base text-ink">
      {paragraph}
    </p>
  ));
}

/** Render extracted readable blocks as safe React text, grouping list items. */
function renderReadableContent(content: ReadableContent): ReactNode {
  const nodes: ReactNode[] = [];
  let listBuffer: { key: string; text: string }[] = [];

  const flushList = (): void => {
    if (listBuffer.length === 0) return;
    const buffered = listBuffer;
    nodes.push(
      <ul
        key={`ul-${nodes.length}`}
        className="flex list-disc flex-col gap-1 ps-5 text-base text-ink"
      >
        {buffered.map((entry) => (
          <li key={entry.key}>{entry.text}</li>
        ))}
      </ul>,
    );
    listBuffer = [];
  };

  content.blocks.forEach((block, index) => {
    const key = `${block.type}-${index}`;
    if (block.type === 'listitem') {
      listBuffer.push({ key, text: block.text });
      return;
    }
    flushList();
    if (block.type === 'heading') {
      const Tag = (block.level === 2 ? 'h3' : 'h4') as 'h3' | 'h4';
      nodes.push(
        <Tag key={key} className="font-semibold text-ink">
          {block.text}
        </Tag>,
      );
    } else {
      nodes.push(
        <p key={key} className="text-base text-ink">
          {block.text}
        </p>,
      );
    }
  });
  flushList();
  return nodes;
}

export function SourceReader({
  url,
  title,
  onClose,
  onCaptureCitation,
  sourceHtml,
  readabilityHtml,
  className,
}: SourceReaderProps): React.ReactElement {
  const t = useT();
  const titleId = useId();
  const draftId = useId();

  // Escape and the focus trap both return focus to the opener (the thread).
  const trapRef = useFocusTrap<HTMLDivElement>(true, { onEscape: onClose });

  const hasSourceHtml = typeof sourceHtml === 'string' && sourceHtml.length > 0;
  const canReadability =
    hasSourceHtml || (typeof readabilityHtml === 'string' && readabilityHtml.length > 0);
  const [readabilityOn, setReadabilityOn] = useState(false);
  const showReadability = readabilityOn && canReadability;

  // Extracted, sanitized readable content (when driven by `sourceHtml`).
  const [content, setContent] = useState<ReadableContent | null>(null);
  useEffect(() => {
    if (!showReadability || !hasSourceHtml || sourceHtml === undefined) return;
    let cancelled = false;
    // DOMPurify removes scripts/handlers (Section 6.12.7) BEFORE extraction; the
    // result is rendered as React text, so no remote markup can execute.
    const safe = String(DOMPurify.sanitize(sourceHtml));
    void runReadability(safe).then((extracted) => {
      if (!cancelled) setContent(extracted);
    });
    return () => {
      cancelled = true;
    };
  }, [showReadability, hasSourceHtml, sourceHtml]);

  // Editable citation draft. Empty until the user captures or types a selection.
  const [draft, setDraft] = useState('');
  const draftRef = useRef<HTMLTextAreaElement>(null);

  const captureSelection = (): void => {
    const selected = typeof window !== 'undefined' ? (window.getSelection()?.toString() ?? '') : '';
    const text = selected.trim();
    if (text.length > 0) {
      setDraft(text);
      // Move focus to the draft so the user can edit before saving.
      draftRef.current?.focus();
    }
  };

  const saveCitation = (): void => {
    const text = draft.trim();
    if (text.length === 0) return;
    onCaptureCitation?.({ url, text });
    setDraft('');
  };

  return (
    <div
      ref={trapRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      className={cn('fixed inset-0 z-modal flex flex-col bg-canvas text-ink', className)}
    >
      {/* Toolbar — DOM order: Back, title, mode toggle. */}
      <div className="flex items-center gap-2 border-b border-line bg-surface px-4 py-2">
        <Button
          iconOnly
          variant="ghost"
          onClick={onClose}
          aria-label={t('reader.back', 'Back to thread')}
        >
          <Icon name="arrow-left" />
        </Button>

        <h2 id={titleId} className="min-w-0 flex-1 truncate text-lg font-semibold text-ink">
          {title}
        </h2>

        {canReadability ? (
          <Button
            variant="secondary"
            onClick={() => setReadabilityOn((on) => !on)}
            aria-pressed={showReadability}
          >
            <Icon name="document-check" className="size-4" />
            {t('reader.readability', 'Reader view')}
          </Button>
        ) : null}
      </div>

      {/* Source URL line — visible provenance; not a navigable link (the frame
          is sandboxed and we never hand the user a top-navigation target here). */}
      <p className="truncate border-b border-line px-4 py-1 text-xs text-ink-muted">{url}</p>

      {/* Content region */}
      <div className="min-h-0 flex-1 overflow-auto">
        {showReadability ? (
          <article className="mx-auto flex max-w-prose flex-col gap-4 p-4">
            {hasSourceHtml ? (
              content ? (
                content.blocks.length > 0 ? (
                  renderReadableContent(content)
                ) : (
                  <p className="text-base text-ink-muted">
                    {t('reader.readability.empty', 'No readable content could be extracted.')}
                  </p>
                )
              ) : (
                <p className="text-base text-ink-muted" aria-live="polite">
                  {t('reader.readability.loading', 'Extracting readable content…')}
                </p>
              )
            ) : (
              renderReadabilityParagraphs(readabilityHtml ?? '')
            )}
          </article>
        ) : (
          <iframe
            // EMPTY sandbox = maximally restrictive: no scripts, no same-origin,
            // no forms, no popups, no top-navigation. Do NOT add allow-* tokens.
            sandbox=""
            src={url}
            title={t('reader.frame.title', 'External source: {title}', { title })}
            className="h-full w-full border-0"
          />
        )}
      </div>

      {/* Citation capture — optional. Lets the reader lift an excerpt into an
          editable citation, then emit it via onCaptureCitation. */}
      {onCaptureCitation ? (
        <div className="flex flex-col gap-2 border-t border-line bg-surface p-4">
          <div className="flex items-center justify-between gap-2">
            <label htmlFor={draftId} className="text-sm font-medium text-ink">
              {t('reader.citation.label', 'Citation excerpt')}
            </label>
            <Button variant="ghost" onClick={captureSelection}>
              <Icon name="quote" className="size-4" />
              {t('reader.citation.capture', 'Capture selection')}
            </Button>
          </div>
          <textarea
            ref={draftRef}
            id={draftId}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            rows={3}
            placeholder={t(
              'reader.citation.placeholder',
              'Select text in the source, then capture it — or type the excerpt here.',
            )}
            className="w-full resize-y rounded-md border border-line-strong bg-canvas p-2 text-base text-ink placeholder:text-ink-placeholder focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
          />
          <div className="flex justify-end">
            <Button variant="primary" onClick={saveCitation} disabled={draft.trim().length === 0}>
              <Icon name="plus" className="size-4" />
              {t('reader.citation.save', 'Save citation')}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
