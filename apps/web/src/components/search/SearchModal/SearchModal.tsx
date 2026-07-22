// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The public-content search modal (WS-F.3.1b — the reader surface of the
// unified search engine). A top-anchored command-palette dialog: debounced
// typeahead over `GET /v1/search` (stories + comments + public rooms; the
// server weights WS-T `validated` results up and filters `incorrect` out),
// an ARIA combobox/listbox with full keyboard navigation, per-type sections,
// query-term highlighting, and the standard Dialog a11y contract (focus trap,
// Escape, scroll lock, backdrop dismiss, focus restore). Rendered lazily by
// SearchModalHost so none of this enters the initial bundle.
import type { SearchResult, SearchResultType } from '@licio/shared';
import type { UseNavigateResult } from '@tanstack/react-router';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useDebouncedValue } from '../../../hooks/useDebouncedValue.js';
import { useFocusTrap } from '../../../hooks/useFocusTrap.js';
import { useScrollLock } from '../../../hooks/useScrollLock.js';
import { useT } from '../../../i18n/index.js';
import { cn } from '../../../lib/cn.js';
import { type SearchTypeFilter, useSearchQuery } from '../../../lib/queries.js';
import { SEARCH_MIN_QUERY_LENGTH } from '../../../lib/search-api.js';
import { DisputeBadge } from '../../story/DisputeBadge/DisputeBadge.js';
import { Button } from '../../ui/Button/index.js';
import { EmptyState } from '../../ui/EmptyState/index.js';
import { ErrorState } from '../../ui/ErrorState/index.js';
import { Icon, type IconName } from '../../ui/Icon/index.js';
import { LoadingState } from '../../ui/LoadingState/index.js';
import { highlightMatches, queryTokens } from '../highlight.js';

export interface SearchModalProps {
  onClose: () => void;
  /** Injected by SearchModalHost (which lives in the router context of the
   *  ENTRY bundle) so this LAZY chunk carries no @tanstack/react-router
   *  runtime import of its own — a type-only edge, erased at compile time. */
  navigate: UseNavigateResult<string>;
}

const DEBOUNCE_MS = 250;

/** Display sections, in order; each groups one result type. */
const SECTIONS: ReadonlyArray<{
  type: SearchResultType;
  icon: IconName;
  labelKey: string;
  labelDefault: string;
}> = [
  { type: 'story', icon: 'layers', labelKey: 'search.section.stories', labelDefault: 'Stories' },
  { type: 'comment', icon: 'quote', labelKey: 'search.section.comments', labelDefault: 'Comments' },
  { type: 'room', icon: 'grid', labelKey: 'search.section.rooms', labelDefault: 'Rooms' },
];

const FILTERS: ReadonlyArray<{ key: SearchTypeFilter; labelKey: string; labelDefault: string }> = [
  { key: 'all', labelKey: 'search.filter.all', labelDefault: 'All' },
  { key: 'story', labelKey: 'search.filter.stories', labelDefault: 'Stories' },
  { key: 'comment', labelKey: 'search.filter.comments', labelDefault: 'Comments' },
  { key: 'room', labelKey: 'search.filter.rooms', labelDefault: 'Rooms' },
];

function Kbd({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <kbd className="rounded border border-line bg-surface px-1 py-0.5 font-sans text-[10px] leading-none text-ink-muted">
      {children}
    </kbd>
  );
}

export function SearchModal({ onClose, navigate }: SearchModalProps): React.ReactPortal | null {
  const t = useT();
  const inputRef = useRef<HTMLInputElement>(null);
  const trapRef = useFocusTrap<HTMLDivElement>(true, {
    onEscape: onClose,
    initialFocusRef: inputRef,
  });
  useScrollLock(true);

  const titleId = useId();
  const listboxId = useId();
  const [input, setInput] = useState('');
  const [filter, setFilter] = useState<SearchTypeFilter>('all');
  const [activeIndex, setActiveIndex] = useState(-1);
  const query = useDebouncedValue(input.trim(), DEBOUNCE_MS);
  const longEnough = query.length >= SEARCH_MIN_QUERY_LENGTH;
  const search = useSearchQuery(query, filter);
  const tokens = useMemo(() => queryTokens(query), [query]);

  // Sectioned + flattened views of the same ordered results: the listbox
  // renders sections, keyboard navigation walks the flat display order.
  const sections = useMemo(() => {
    const items = longEnough ? (search.data?.items ?? []) : [];
    let flatIndex = 0;
    return SECTIONS.map((section) => ({
      ...section,
      items: items
        .filter((result) => result.result_type === section.type)
        .map((result) => ({ result, flatIndex: flatIndex++ })),
    })).filter((section) => section.items.length > 0);
  }, [longEnough, search.data]);
  const flat = useMemo(
    () => sections.flatMap((section) => section.items.map((item) => item.result)),
    [sections],
  );

  // New result set ⇒ nothing active until the reader navigates again.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset keys off the data identity deliberately.
  useEffect(() => setActiveIndex(-1), [search.data, filter]);

  const optionId = (index: number): string => `${listboxId}-option-${index}`;

  // `scrollIntoView` is unimplemented in jsdom, so guard the call.
  // biome-ignore lint/correctness/useExhaustiveDependencies: optionId is render-stable (derived from useId).
  useEffect(() => {
    if (activeIndex >= 0) {
      document.getElementById(optionId(activeIndex))?.scrollIntoView?.({ block: 'nearest' });
    }
  }, [activeIndex]);

  const openResult = (result: SearchResult): void => {
    onClose();
    if (result.result_type === 'room') {
      void navigate({ to: '/rooms/$roomId', params: { roomId: result.id } });
      return;
    }
    // Claims are never requested by the modal; story/comment hits always
    // carry their owning story (the navigation key).
    if (result.story_id === null) return;
    if (result.result_type === 'comment') {
      void navigate({
        to: '/stories/$storyId/comments',
        params: { storyId: result.story_id },
        search: { root: result.id },
      });
      return;
    }
    void navigate({ to: '/stories/$storyId', params: { storyId: result.story_id } });
  };

  const onInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (flat.length > 0) setActiveIndex((index) => Math.min(index + 1, flat.length - 1));
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (flat.length > 0) setActiveIndex((index) => Math.max(index - 1, 0));
      return;
    }
    if (event.key === 'Enter') {
      const target = flat[activeIndex] ?? flat[0];
      if (target !== undefined) {
        event.preventDefault();
        openResult(target);
      }
    }
  };

  if (typeof document === 'undefined') return null;

  const showHint = !longEnough;
  const showLoading = longEnough && search.isLoading;
  const showError = longEnough && search.isError;
  const showEmpty = longEnough && !search.isLoading && !search.isError && flat.length === 0;
  const status = showLoading
    ? t('search.searching', 'Searching…')
    : longEnough && !search.isError
      ? t('search.resultTally', '{tally} results', { tally: String(flat.length) })
      : '';

  return createPortal(
    <div className="fixed inset-0 z-modal flex items-start justify-center p-4 pt-[12vh]">
      <button
        type="button"
        aria-hidden="true"
        tabIndex={-1}
        className="absolute inset-0 cursor-default bg-black/50"
        onClick={onClose}
      />
      <div
        ref={trapRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative z-modal flex w-full max-w-xl flex-col overflow-hidden rounded-lg border border-line bg-canvas shadow-lg"
      >
        <h2 id={titleId} className="sr-only">
          {t('search.title', 'Search')}
        </h2>
        <div className="flex items-center gap-3 border-b border-line px-4 py-3">
          <Icon name="search" className="shrink-0 text-ink-muted" />
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded={flat.length > 0}
            aria-controls={listboxId}
            aria-activedescendant={activeIndex >= 0 ? optionId(activeIndex) : undefined}
            aria-autocomplete="list"
            aria-label={t('search.inputLabel', 'Search public content')}
            placeholder={t('search.placeholder', 'Search stories, comments, and rooms…')}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={onInputKeyDown}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
            enterKeyHint="search"
            className="min-h-touch w-full bg-transparent text-base text-ink placeholder:text-ink-muted focus-visible:outline-none"
          />
          <Button
            iconOnly
            variant="ghost"
            aria-label={t('search.close', 'Close search')}
            onClick={onClose}
          >
            <Icon name="x" />
          </Button>
        </div>
        <div
          role="group"
          aria-label={t('search.filters', 'Filter results by type')}
          className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2"
        >
          {FILTERS.map((entry) => (
            <button
              key={entry.key}
              type="button"
              aria-pressed={filter === entry.key}
              onClick={() => setFilter(entry.key)}
              className={cn(
                'min-h-8 rounded-full border px-3 py-1 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
                filter === entry.key
                  ? 'border-primary-active bg-surface-strong text-ink neu-pressed-sm'
                  : 'border-line bg-surface text-ink-muted neu-raised-sm hover:text-ink',
              )}
            >
              {t(entry.labelKey, entry.labelDefault)}
            </button>
          ))}
        </div>
        <p aria-live="polite" className="sr-only">
          {status}
        </p>
        <div className="max-h-[min(60vh,26rem)] overflow-y-auto p-2">
          {showHint ? (
            <p className="px-3 py-6 text-center text-sm text-ink-muted">
              {t('search.hint', 'Type at least {min} characters to search', {
                min: String(SEARCH_MIN_QUERY_LENGTH),
              })}
            </p>
          ) : showLoading ? (
            <LoadingState />
          ) : showError ? (
            <ErrorState onRetry={() => void search.refetch()} />
          ) : showEmpty ? (
            <EmptyState
              title={t('search.noResults', 'No results for “{query}”', { query })}
              description={t(
                'search.noResultsDescription',
                'Try different words, or switch the type filter.',
              )}
            />
          ) : (
            <div
              role="listbox"
              id={listboxId}
              aria-labelledby={titleId}
              className={cn(search.isPlaceholderData && 'opacity-60')}
            >
              {sections.map((section) => (
                <div
                  key={section.type}
                  role="group"
                  aria-labelledby={`${listboxId}-section-${section.type}`}
                >
                  <div
                    id={`${listboxId}-section-${section.type}`}
                    className="px-3 pt-3 pb-1 text-xs font-semibold text-ink-muted uppercase tracking-wide"
                  >
                    {t(section.labelKey, section.labelDefault)}
                  </div>
                  {section.items.map(({ result, flatIndex }) => (
                    // Virtual-focus option (the MultiSelect listbox pattern,
                    // WAI-ARIA combobox APG): keyboard lives on the combobox
                    // input via aria-activedescendant, options are deliberately
                    // not focusable; mousedown is suppressed so focus stays put.
                    // biome-ignore lint/a11y/useFocusableInteractive: virtual focus — the combobox input owns keyboard interaction.
                    // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard activation is Enter on the combobox input, not the option.
                    <div
                      key={result.id}
                      id={optionId(flatIndex)}
                      role="option"
                      aria-selected={flatIndex === activeIndex}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => openResult(result)}
                      onMouseEnter={() => setActiveIndex(flatIndex)}
                      className={cn(
                        'flex cursor-pointer items-start gap-3 rounded-md px-3 py-2',
                        flatIndex === activeIndex
                          ? 'bg-surface neu-pressed-sm'
                          : 'hover:bg-surface',
                      )}
                    >
                      <Icon name={section.icon} className="mt-0.5 shrink-0 text-ink-muted" />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-sm font-medium text-ink">
                            {result.result_type === 'comment'
                              ? t('search.commentOn', 'Comment on {title}', {
                                  title: result.title,
                                })
                              : highlightMatches(result.title, tokens)}
                          </span>
                          <DisputeBadge status={result.dispute_status} className="shrink-0" />
                        </div>
                        {result.snippet !== null && result.snippet.length > 0 ? (
                          <p className="mt-0.5 line-clamp-2 text-sm text-ink-muted">
                            {highlightMatches(result.snippet, tokens)}
                          </p>
                        ) : null}
                      </div>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line px-4 py-2 text-xs text-ink-muted">
          <span className="flex items-center gap-1">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd> {t('search.hintNavigate', 'to navigate')}
          </span>
          <span className="flex items-center gap-1">
            <Kbd>↵</Kbd> {t('search.hintOpen', 'to open')}
          </span>
          <span className="flex items-center gap-1">
            <Kbd>esc</Kbd> {t('search.hintClose', 'to close')}
          </span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
