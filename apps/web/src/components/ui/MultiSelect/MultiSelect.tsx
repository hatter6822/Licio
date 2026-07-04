// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A SEARCHABLE multi-select. The collapsed control is a button styled exactly
// like `Select` (its single-value sibling — shared `listboxTriggerClasses`), so a
// form mixing single- and multi-value pickers reads as one control family. Opening
// it reveals a popover with a SEARCH INPUT above a filtered `listbox` — the search
// input is the WAI-ARIA editable combobox (roving `aria-activedescendant`,
// `aria-autocomplete="list"`), the listbox is `aria-multiselectable`. This scales
// to a large catalog: you type to narrow instead of scanning a wall of options.
//
// The chosen values render as removable chips in a row BELOW the trigger; the
// collapsed control never grows with the option-set size (it stays one row), so a
// big catalog costs no fixed vertical space. An optional `max` is enforced in ONE
// place — over-cap options show disabled in the popover; already-selected ones stay
// removable (via a chip, the popover, or Backspace on an empty query).
//
// Like `Select`, it is i18n-agnostic: every user-visible string is passed in (with
// English defaults), so translation stays at the call site.
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { cn } from '../../../lib/cn.js';
import {
  listboxOptionClasses,
  listboxTriggerClasses,
  popoverPanelClasses,
} from '../../../lib/controls.js';
import { Icon } from '../Icon/index.js';

export interface MultiSelectOption {
  value: string;
  label: string;
}

export interface MultiSelectProps {
  /** Visible, programmatically-associated label for the whole field. */
  label: string;
  /** Explicit id for the trigger; auto-generated when omitted. */
  id?: string;
  /** Controlled selected values (order preserved as chosen). */
  value: string[];
  onChange: (values: string[]) => void;
  options: MultiSelectOption[];
  /**
   * Maximum number of selections. When reached, still-unselected options are
   * shown disabled in the popover (already-selected ones stay removable). Omit
   * for no limit.
   */
  max?: number;
  /** Trigger text when nothing is selected. Never a substitute for the label. */
  placeholder?: string;
  /** Trigger text once at least one value is selected (the chips show the picks). */
  summaryLabel?: (selected: number, max: number | undefined) => string;
  /** Placeholder shown inside the search input. */
  searchPlaceholder?: string;
  /** Accessible label for the search input (the editable combobox). */
  searchLabel?: string;
  /** Message shown when the search query matches no options. */
  noResultsLabel?: string;
  /** Error message. Sets `aria-invalid` and links the message via `aria-describedby`. */
  error?: string;
  /** Non-error helper text, linked via `aria-describedby`. */
  helperText?: ReactNode;
  required?: boolean;
  /** Visually hide the label while keeping it for assistive tech. */
  hideLabel?: boolean;
  disabled?: boolean;
  className?: string;
  /** Accessible label for a chip's remove control. */
  removeLabel?: (optionLabel: string) => string;
  /** Accessible label for the chip region (the group of current selections). */
  selectionsLabel?: string;
  /** Note shown once `max` is reached (explains why unselected options disabled). */
  capNote?: string;
}

const defaultSummary = (selected: number, max: number | undefined): string =>
  max !== undefined ? `${selected} of ${max} selected` : `${selected} selected`;

export function MultiSelect({
  label,
  id,
  value,
  onChange,
  options,
  max,
  placeholder = 'Choose options',
  summaryLabel = defaultSummary,
  searchPlaceholder = 'Search…',
  searchLabel = 'Search options',
  noResultsLabel = 'No matches',
  error,
  helperText,
  required = false,
  hideLabel = false,
  disabled = false,
  className,
  removeLabel = (optionLabel) => `Remove ${optionLabel}`,
  selectionsLabel = 'Selected',
  capNote,
}: MultiSelectProps): React.ReactElement {
  const generatedId = useId();
  const triggerId = id ?? generatedId;
  const labelId = `${triggerId}-label`;
  const listboxId = `${triggerId}-listbox`;
  const searchId = `${triggerId}-search`;
  const errorId = `${triggerId}-error`;
  const helperId = `${triggerId}-helper`;
  const capId = `${triggerId}-cap`;
  const optionDomId = (index: number): string => `${triggerId}-option-${index}`;

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  // The option the user is navigating to with the keyboard (roving virtual focus
  // via aria-activedescendant), indexed into the FILTERED list below.
  const [activeIndex, setActiveIndex] = useState(-1);

  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const optionRefs = useRef<Array<HTMLDivElement | null>>([]);
  const chipButtonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  // When a chip's remove button unmounts, DOM focus would fall to <body>; this
  // records where to re-home it (see the layout effect below).
  const pendingChipFocus = useRef<number | null>(null);

  const selectedSet = useMemo(() => new Set(value), [value]);
  // Chips render in SELECTION order (as the author chose them), not catalog order.
  const selectedOptions = useMemo(
    () =>
      value
        .map((val) => options.find((option) => option.value === val))
        .filter((option): option is MultiSelectOption => option !== undefined),
    [value, options],
  );
  const atCap = max !== undefined && value.length >= max;
  const isDisabledOption = useCallback(
    (option: MultiSelectOption): boolean => atCap && !selectedSet.has(option.value),
    [atCap, selectedSet],
  );

  // Case-insensitive substring filter on the option label.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q === '') return options;
    return options.filter((option) => option.label.toLowerCase().includes(q));
  }, [options, query]);

  const describedBy =
    cn(
      error ? errorId : undefined,
      helperText ? helperId : undefined,
      atCap && capNote ? capId : undefined,
    ) || undefined;

  const openPopover = useCallback(() => {
    if (disabled) return;
    setOpen(true);
    setQuery('');
    setActiveIndex(options.length > 0 ? 0 : -1);
  }, [disabled, options.length]);

  const closePopover = useCallback((returnFocus: boolean) => {
    setOpen(false);
    setQuery('');
    setActiveIndex(-1);
    if (returnFocus) triggerRef.current?.focus();
  }, []);

  // Toggle one value, honouring `max`: an already-selected value always removes;
  // a new value is added only below the cap (an over-cap add is a no-op). The
  // popover STAYS OPEN so several values can be picked in a row.
  const toggle = useCallback(
    (optionValue: string) => {
      if (disabled) return;
      if (selectedSet.has(optionValue)) {
        onChange(value.filter((val) => val !== optionValue));
        return;
      }
      if (max !== undefined && value.length >= max) return;
      onChange([...value, optionValue]);
    },
    [disabled, selectedSet, onChange, value, max],
  );

  // Remove a chip via its own remove control, recording the removed index so DOM
  // focus can be re-homed after the button unmounts (see the layout effect).
  const removeChip = useCallback(
    (optionValue: string, index: number) => {
      if (disabled) return;
      pendingChipFocus.current = index;
      onChange(value.filter((val) => val !== optionValue));
    },
    [disabled, onChange, value],
  );

  // Move focus to the search input when the popover opens.
  useEffect(() => {
    if (open) searchRef.current?.focus();
  }, [open]);

  // After a chip removal re-render, move focus to the chip that shifted into the
  // removed slot (or the last remaining chip, or the trigger if none remain) so a
  // keyboard/screen-reader user is never dropped to <body>.
  useLayoutEffect(() => {
    const target = pendingChipFocus.current;
    if (target === null) return;
    pendingChipFocus.current = null;
    const remaining = value.length;
    if (remaining === 0) {
      triggerRef.current?.focus();
      return;
    }
    chipButtonRefs.current[Math.min(target, remaining - 1)]?.focus();
  }, [value]);

  // Keep the active option scrolled into view as the user arrows through.
  // `scrollIntoView` is unimplemented in jsdom, so guard the call.
  useEffect(() => {
    if (open && activeIndex >= 0) {
      optionRefs.current[activeIndex]?.scrollIntoView?.({ block: 'nearest' });
    }
  }, [open, activeIndex]);

  // Close on a click outside the component.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent): void => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        closePopover(false);
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open, closePopover]);

  const handleTriggerKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>): void => {
    if (disabled || open) return;
    if (event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowDown') {
      event.preventDefault();
      openPopover();
    }
  };

  const handleSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    const count = filtered.length;
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        setActiveIndex((index) => (count === 0 ? -1 : index < 0 ? 0 : (index + 1) % count));
        return;
      case 'ArrowUp':
        event.preventDefault();
        setActiveIndex((index) => (count === 0 ? -1 : index <= 0 ? count - 1 : index - 1));
        return;
      case 'Home':
        // Only steer the list when the query is empty; otherwise leave Home/End to
        // the input so the caret can move within a typed query.
        if (query === '' && count > 0) {
          event.preventDefault();
          setActiveIndex(0);
        }
        return;
      case 'End':
        if (query === '' && count > 0) {
          event.preventDefault();
          setActiveIndex(count - 1);
        }
        return;
      case 'Enter': {
        event.preventDefault();
        const option = activeIndex >= 0 ? filtered[activeIndex] : undefined;
        if (option && !isDisabledOption(option)) toggle(option.value);
        return;
      }
      case 'Escape':
      case 'Tab':
        // Dismiss and return focus to the trigger (Tab does not tab through the
        // popover — it closes it, then continues from the trigger).
        event.preventDefault();
        closePopover(true);
        return;
      case 'Backspace':
        // A tags-input nicety: Backspace on an empty query removes the last chip
        // (focus stays in the search input for continued typing).
        if (query === '' && value.length > 0 && !disabled) {
          event.preventDefault();
          onChange(value.slice(0, -1));
        }
        return;
      default:
        return;
    }
  };

  const onSearchChange = (event: React.ChangeEvent<HTMLInputElement>): void => {
    const next = event.target.value;
    setQuery(next);
    const q = next.trim().toLowerCase();
    const nextFiltered =
      q === '' ? options : options.filter((option) => option.label.toLowerCase().includes(q));
    setActiveIndex(nextFiltered.length > 0 ? 0 : -1);
  };

  const triggerText = value.length === 0 ? placeholder : summaryLabel(value.length, max);
  const activeDescendant = open && activeIndex >= 0 ? optionDomId(activeIndex) : undefined;

  return (
    <div ref={containerRef} className={cn('flex flex-col gap-1', className)}>
      <span id={labelId} className={cn('text-sm font-medium text-ink', hideLabel && 'sr-only')}>
        {label}
        {required ? (
          <span className="ms-0.5 text-error-on-soft" aria-hidden="true">
            *
          </span>
        ) : null}
      </span>

      {helperText ? (
        <p id={helperId} className="text-sm text-ink-muted">
          {helperText}
        </p>
      ) : null}

      <div className="relative">
        <button
          ref={triggerRef}
          id={triggerId}
          type="button"
          disabled={disabled}
          // A disclosure button (same styling as Select's trigger) that opens a
          // popover whose search input is the editable combobox.
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={open ? listboxId : undefined}
          aria-labelledby={labelId}
          // aria-required/aria-invalid are not permitted on a button role; they
          // live on the editable combobox (the search input) below. When closed,
          // required is conveyed by the visible "*" and the error via
          // aria-describedby (which a button DOES allow).
          aria-describedby={describedBy}
          onClick={() => (open ? closePopover(false) : openPopover())}
          onKeyDown={handleTriggerKeyDown}
          className={cn(
            listboxTriggerClasses,
            error ? 'border-error' : 'border-line-strong',
            disabled && 'cursor-not-allowed opacity-60',
          )}
        >
          <span className={cn('truncate', value.length === 0 && 'text-ink-placeholder')}>
            {triggerText}
          </span>
          <Icon name="chevron-down" className="size-5 text-ink-muted" />
        </button>

        {open ? (
          <div className={cn(popoverPanelClasses, 'p-1')}>
            <div className="relative mb-1">
              <Icon
                name="search"
                className="pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2 text-ink-muted"
              />
              <input
                ref={searchRef}
                id={searchId}
                type="text"
                // The editable combobox (WAI-ARIA): it filters + drives the listbox
                // via aria-activedescendant while DOM focus stays here.
                role="combobox"
                aria-expanded="true"
                aria-controls={listboxId}
                aria-activedescendant={activeDescendant}
                aria-autocomplete="list"
                aria-label={searchLabel}
                aria-required={required || undefined}
                aria-invalid={error ? true : undefined}
                aria-describedby={describedBy}
                autoComplete="off"
                value={query}
                onChange={onSearchChange}
                onKeyDown={handleSearchKeyDown}
                placeholder={searchPlaceholder}
                className="w-full rounded-md border border-line bg-canvas py-2 ps-9 pe-3 text-base text-ink placeholder:text-ink-placeholder focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
              />
            </div>

            {/* The listbox is ALWAYS present (a role="combobox" requires a live
                aria-controls target); it is simply empty when the query matches
                nothing, and the no-match copy renders as a sibling status below. */}
            <div
              id={listboxId}
              role="listbox"
              aria-multiselectable="true"
              aria-label={label}
              className="max-h-60 overflow-auto"
            >
              {filtered.map((option, index) => {
                const isSelected = selectedSet.has(option.value);
                const isActive = index === activeIndex;
                const optionDisabled = isDisabledOption(option);
                return (
                  // Virtual-focus option: keyboard is handled on the search
                  // combobox, so options are not focusable and carry no key
                  // handler; pointer toggles them.
                  <div
                    key={option.value}
                    ref={(node) => {
                      optionRefs.current[index] = node;
                    }}
                    id={optionDomId(index)}
                    role="option"
                    aria-selected={isSelected}
                    aria-disabled={optionDisabled || undefined}
                    data-active={isActive || undefined}
                    // Suppress mousedown so focus stays in the search input.
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => {
                      if (!optionDisabled) toggle(option.value);
                    }}
                    className={cn(
                      listboxOptionClasses,
                      isActive && 'bg-primary-soft text-primary-on-soft',
                      optionDisabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
                    )}
                  >
                    <span className="truncate">{option.label}</span>
                    {isSelected ? <Icon name="check" className="size-5 text-primary" /> : null}
                  </div>
                );
              })}
            </div>
            {/* A stable live region (present for the whole open session) whose
                text toggles, so a query going empty is reliably announced; it is
                sr-only while there are results (no layout, nothing to announce). */}
            <p
              role="status"
              className={cn('px-3 py-2 text-ink-muted text-sm', filtered.length > 0 && 'sr-only')}
            >
              {filtered.length === 0 ? noResultsLabel : ''}
            </p>
          </div>
        ) : null}
      </div>

      {selectedOptions.length > 0 ? (
        <div className="flex flex-wrap gap-1.5" role="list" aria-label={selectionsLabel}>
          {selectedOptions.map((option, index) => (
            <span
              key={option.value}
              role="listitem"
              className="inline-flex items-center gap-1 rounded-full border border-line bg-surface py-1 ps-3 pe-1 text-ink text-sm neu-raised-sm"
            >
              <span>{option.label}</span>
              <button
                ref={(node) => {
                  chipButtonRefs.current[index] = node;
                }}
                type="button"
                disabled={disabled}
                aria-label={removeLabel(option.label)}
                onClick={() => removeChip(option.value, index)}
                className="inline-flex size-6 items-center justify-center rounded-full text-ink-muted transition hover:bg-surface-sunken hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus disabled:cursor-not-allowed"
              >
                <Icon name="x" className="size-3.5" />
              </button>
            </span>
          ))}
        </div>
      ) : null}

      {atCap && capNote ? (
        <p id={capId} className="text-ink-muted text-sm">
          {capNote}
        </p>
      ) : null}

      {error ? (
        <p id={errorId} className="flex items-center gap-1 text-error-on-soft text-sm">
          <Icon name="octagon-exclamation" className="size-4" />
          <span>{error}</span>
        </p>
      ) : null}
    </div>
  );
}
