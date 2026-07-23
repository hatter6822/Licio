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
//
// ONE modal serves all three SCOPES (see SearchButton): global public content,
// one room's pool (WS-Q.2.5b), or one story's conversation (WS-T.7.3). The
// scope is not decoration — it selects a different corpus server-side, so the
// dialog NAMES it (heading, placeholder, and the pressed scope chip) and offers
// only the type filters that scope can actually return.
//
// The opening surface supplies a DEFAULT, not a cage. Searching a room from
// that room's banner is almost always the intent, but a reader who comes up
// empty must be able to widen to the whole site — or step out to the
// surrounding room — without closing the dialog, retyping, and navigating
// elsewhere first. So the scope is local state here: the query text, the
// caret, and the result list all survive a scope change, and only the corpus
// moves.
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
import {
  SEARCH_MIN_QUERY_LENGTH,
  type SearchScope,
  type SearchScopeOptions,
  scopeKey,
} from '../../../lib/search-api.js';
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
  /** The scopes the opening surface offers, in menu order; the first is the
   *  initial selection. Empty (the default) is the global surface alone. */
  scopes?: SearchScopeOptions;
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

interface FilterDescriptor {
  key: SearchTypeFilter;
  labelKey: string;
  labelDefault: string;
}

const FILTERS: readonly FilterDescriptor[] = [
  { key: 'all', labelKey: 'search.filter.all', labelDefault: 'All' },
  { key: 'story', labelKey: 'search.filter.stories', labelDefault: 'Stories' },
  { key: 'comment', labelKey: 'search.filter.comments', labelDefault: 'Comments' },
  { key: 'room', labelKey: 'search.filter.rooms', labelDefault: 'Rooms' },
];

/**
 * The type filters a scope can offer — the client mirror of the server's
 * per-scope corpora (`scopeSearchTypes`). A room-scoped search never returns
 * the room record itself, and a story-scoped one returns comments only, so a
 * single-type filter row would be a control with nothing to switch between:
 * a scope with one corpus offers no filters at all.
 */
function scopeFilters(scope: SearchScope | null): readonly FilterDescriptor[] {
  if (scope === null) return FILTERS;
  if (scope.kind === 'story') return [];
  return FILTERS.filter((entry) => entry.key !== 'room');
}

/** The icon that stands for a scope in the chip row and the section list. */
function scopeIcon(scope: SearchScope | null): IconName {
  if (scope === null) return 'globe';
  return scope.kind === 'room' ? 'grid' : 'quote';
}

function Kbd({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <kbd className="rounded border border-line bg-surface px-1 py-0.5 font-sans text-[10px] leading-none text-ink-muted">
      {children}
    </kbd>
  );
}

export function SearchModal({
  onClose,
  navigate,
  scopes = [],
}: SearchModalProps): React.ReactPortal | null {
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
  // The surface's scopes, then GLOBAL — always last and always present, so
  // widening out of a scope is one press away from wherever the reader started.
  const choices = useMemo<readonly (SearchScope | null)[]>(() => [...scopes, null], [scopes]);
  const [scope, setScope] = useState<SearchScope | null>(() => scopes[0] ?? null);
  const query = useDebouncedValue(input.trim(), DEBOUNCE_MS);
  const longEnough = query.length >= SEARCH_MIN_QUERY_LENGTH;
  const search = useSearchQuery(query, filter, scope);
  const tokens = useMemo(() => queryTokens(query), [query]);
  const filters = scopeFilters(scope);

  /**
   * Switch corpus, keeping everything the reader has already invested: the
   * query text stays, so the same words re-run against the new scope.
   *
   * The TYPE filter is carried across only when the new scope can still serve
   * it — widening from a room to the global surface keeps "Comments", but
   * narrowing to a story's conversation (comments only) drops a "Stories"
   * filter that would otherwise ask the server for a corpus this scope does
   * not have. The active option resets either way: the result list is about to
   * be replaced, and Enter must never activate a hit from the old corpus.
   */
  const changeScope = (next: SearchScope | null): void => {
    setScope(next);
    setActiveIndex(-1);
    const allowed = scopeFilters(next);
    if (!allowed.some((entry) => entry.key === filter)) setFilter('all');
  };

  // Scope-dependent copy. The dialog must SAY what it searches: an unlabelled
  // scoped search that silently returns fewer results reads as a broken global
  // search.
  const heading =
    scope === null
      ? t('search.title', 'Search')
      : scope.kind === 'room'
        ? t('search.title.room', 'Search this room')
        : t('search.title.story', 'Search this conversation');
  const placeholder =
    scope === null
      ? t('search.placeholder', 'Search stories, comments, and rooms…')
      : scope.kind === 'room'
        ? t('search.placeholder.room', 'Search stories and comments in this room…')
        : t('search.placeholder.story', 'Search comments on this story…');
  // The combobox keeps its own name (the dialog is already named by `heading`);
  // a scoped search reuses the scope name, which is the more specific of the two.
  const inputLabel = scope === null ? t('search.inputLabel', 'Search public content') : heading;
  /**
   * Chip text. A room chip carries the room's NAME — that is what tells two
   * scopes apart on a story page ("This conversation" vs "Harbor District").
   * A story chip does not: exactly one story scope is ever offered, and the
   * story's title is a headline, far too long for a chip. The full title
   * survives as the chip's tooltip, so the reader can still confirm which
   * story they are inside.
   */
  const chipLabel = (choice: SearchScope | null): string => {
    if (choice === null) return t('search.scope.global', 'All of Licio');
    return choice.kind === 'story' ? t('search.scope.story', 'This conversation') : choice.label;
  };

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
          {heading}
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
            aria-label={inputLabel}
            placeholder={placeholder}
            value={input}
            onChange={(event) => {
              setInput(event.target.value);
              // An edited query invalidates any prior selection IMMEDIATELY:
              // placeholderData keeps the old result set rendered through the
              // debounce, and Enter must never activate a result the reader
              // selected under the previous query.
              setActiveIndex(-1);
            }}
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
        {/* WHERE the search runs. Rendered only when there is a genuine choice
            (the front page offers none), and always ending in "All of Licio" so
            widening is one press away. The pressed chip doubles as the label
            the scope pill used to be, so naming the corpus costs no extra row. */}
        {choices.length > 1 ? (
          <div
            role="group"
            aria-label={t('search.scopes', 'Choose where to search')}
            className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2"
          >
            <span className="shrink-0 text-ink-muted text-xs">
              {t('search.scope.within', 'Search in')}
            </span>
            {choices.map((choice) => {
              const selected = scopeKey(choice) === scopeKey(scope);
              return (
                <button
                  key={scopeKey(choice)}
                  type="button"
                  aria-pressed={selected}
                  // The full story headline / room name, for a chip that had to
                  // shorten or truncate it.
                  {...(choice !== null ? { title: choice.label } : {})}
                  onClick={() => changeScope(choice)}
                  className={cn(
                    'inline-flex min-h-8 max-w-[12rem] items-center gap-1 rounded-full border px-3 py-1 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
                    selected
                      ? 'border-primary-active bg-surface-strong text-ink neu-pressed-sm'
                      : 'border-line bg-surface text-ink-muted neu-raised-sm hover:text-ink',
                  )}
                >
                  <Icon name={scopeIcon(choice)} className="size-3.5 shrink-0" aria-hidden="true" />
                  <span className="truncate">{chipLabel(choice)}</span>
                </button>
              );
            })}
          </div>
        ) : null}
        {filters.length > 0 ? (
          <div
            role="group"
            aria-label={t('search.filters', 'Filter results by type')}
            className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2"
          >
            {filters.map((entry) => (
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
        ) : null}
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
              // Honest next step. A scoped miss usually means the match is
              // simply OUTSIDE the scope, and the fix is right there in the
              // chip row — so say so rather than sending the reader to the
              // front page (which the old copy did, before widening was
              // possible from inside the dialog).
              description={
                scope !== null
                  ? t(
                      'search.noResultsDescriptionScoped',
                      'Try different words, or widen the search above.',
                    )
                  : t(
                      'search.noResultsDescription',
                      'Try different words, or switch the type filter.',
                    )
              }
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
