// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { cn } from '../../../lib/cn.js';
import { Icon } from '../Icon/index.js';

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectProps {
  /** Visible, programmatically-associated label (never replaced by a placeholder). */
  label: string;
  /** Explicit id for the trigger; auto-generated when omitted. */
  id?: string;
  /** Controlled selected value. */
  value?: string;
  /** Uncontrolled initial value. */
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  options: SelectOption[];
  /** Shown on the trigger when nothing is selected. Never a substitute for the label. */
  placeholder?: string;
  /** Error message. Sets `aria-invalid` and links the message via `aria-describedby`. */
  error?: string;
  /** Non-error helper text, linked via `aria-describedby`. */
  helperText?: ReactNode;
  required?: boolean;
  /** Visually hide the label while keeping it for assistive tech. */
  hideLabel?: boolean;
  disabled?: boolean;
  className?: string;
}

const triggerBase =
  'flex min-h-touch w-full items-center justify-between gap-2 rounded-md border bg-canvas px-3 py-2 text-left text-base text-ink transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus';

const optionBase =
  'flex min-h-touch cursor-pointer items-center justify-between gap-2 px-3 py-2 text-base text-ink';

export function Select({
  label,
  id,
  value,
  defaultValue,
  onValueChange,
  options,
  placeholder = 'Select an option',
  error,
  helperText,
  required = false,
  hideLabel = false,
  disabled = false,
  className,
}: SelectProps): React.ReactElement {
  const generatedId = useId();
  const triggerId = id ?? generatedId;
  const labelId = `${triggerId}-label`;
  const listboxId = `${triggerId}-listbox`;
  const errorId = `${triggerId}-error`;
  const helperId = `${triggerId}-helper`;
  const optionDomId = (index: number): string => `${triggerId}-option-${index}`;

  const isControlled = value !== undefined;
  const [internalValue, setInternalValue] = useState<string | undefined>(defaultValue);
  const selectedValue = isControlled ? value : internalValue;
  const selectedIndex = options.findIndex((option) => option.value === selectedValue);
  const selectedOption = selectedIndex >= 0 ? options[selectedIndex] : undefined;

  const [open, setOpen] = useState(false);
  // The option the user is navigating to with the keyboard (roving virtual focus
  // via aria-activedescendant). Distinct from the committed `selectedValue`.
  const [activeIndex, setActiveIndex] = useState(-1);

  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Array<HTMLDivElement | null>>([]);
  // Type-ahead buffer: characters typed within a short window jump to a match.
  const typeahead = useRef<{ text: string; timer: number | undefined }>({
    text: '',
    timer: undefined,
  });

  const describedBy =
    cn(error ? errorId : undefined, helperText ? helperId : undefined) || undefined;

  const openListbox = useCallback(
    (focusIndex: number) => {
      if (disabled) {
        return;
      }
      setOpen(true);
      setActiveIndex(focusIndex >= 0 ? focusIndex : 0);
    },
    [disabled],
  );

  const closeListbox = useCallback((returnFocus: boolean) => {
    setOpen(false);
    setActiveIndex(-1);
    if (returnFocus) {
      triggerRef.current?.focus();
    }
  }, []);

  const commit = useCallback(
    (index: number) => {
      const option = options[index];
      if (!option) {
        return;
      }
      if (!isControlled) {
        setInternalValue(option.value);
      }
      onValueChange?.(option.value);
      closeListbox(true);
    },
    [options, isControlled, onValueChange, closeListbox],
  );

  // Keep the active option scrolled into view as the user arrows through.
  // `scrollIntoView` is unimplemented in jsdom, so guard the call.
  useEffect(() => {
    if (open && activeIndex >= 0) {
      const node = optionRefs.current[activeIndex];
      node?.scrollIntoView?.({ block: 'nearest' });
    }
  }, [open, activeIndex]);

  // Close on a click outside the component.
  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointerDown = (event: MouseEvent): void => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        closeListbox(false);
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open, closeListbox]);

  // Clear any pending type-ahead timer on unmount.
  useEffect(
    () => () => {
      if (typeahead.current.timer !== undefined) {
        window.clearTimeout(typeahead.current.timer);
      }
    },
    [],
  );

  const runTypeahead = useCallback(
    (char: string) => {
      const buffer = typeahead.current;
      if (buffer.timer !== undefined) {
        window.clearTimeout(buffer.timer);
      }
      buffer.text += char.toLowerCase();
      buffer.timer = window.setTimeout(() => {
        buffer.text = '';
        buffer.timer = undefined;
      }, 500);

      const match = options.findIndex((option) =>
        option.label.toLowerCase().startsWith(buffer.text),
      );
      if (match >= 0) {
        setActiveIndex(match);
      }
    },
    [options],
  );

  const handleTriggerKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>): void => {
    if (disabled) {
      return;
    }

    if (!open) {
      switch (event.key) {
        case 'Enter':
        case ' ':
        case 'ArrowDown':
          event.preventDefault();
          openListbox(selectedIndex);
          return;
        case 'ArrowUp':
          event.preventDefault();
          openListbox(selectedIndex >= 0 ? selectedIndex : options.length - 1);
          return;
        default:
          return;
      }
    }

    const count = options.length;
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        setActiveIndex((index) => (count === 0 ? -1 : (Math.max(index, 0) + 1) % count));
        return;
      case 'ArrowUp':
        event.preventDefault();
        setActiveIndex((index) => (count === 0 ? -1 : (Math.max(index, 0) - 1 + count) % count));
        return;
      case 'Home':
        event.preventDefault();
        setActiveIndex(count > 0 ? 0 : -1);
        return;
      case 'End':
        event.preventDefault();
        setActiveIndex(count > 0 ? count - 1 : -1);
        return;
      case 'Enter':
      case ' ':
        event.preventDefault();
        if (activeIndex >= 0) {
          commit(activeIndex);
        }
        return;
      case 'Escape':
        event.preventDefault();
        closeListbox(true);
        return;
      case 'Tab':
        // Tabbing away commits nothing and dismisses the popup without trapping.
        closeListbox(false);
        return;
      default:
        if (event.key.length === 1 && !event.altKey && !event.ctrlKey && !event.metaKey) {
          runTypeahead(event.key);
        }
    }
  };

  const triggerLabel = selectedOption ? selectedOption.label : placeholder;

  return (
    <div ref={containerRef} className={cn('flex flex-col gap-1', className)}>
      <span id={labelId} className={cn('text-sm font-medium text-ink', hideLabel && 'sr-only')}>
        {label}
        {required ? (
          <span className="ml-0.5 text-error-on-soft" aria-hidden="true">
            *
          </span>
        ) : null}
      </span>

      <div className="relative">
        <button
          ref={triggerRef}
          id={triggerId}
          type="button"
          // Select-only combobox (WAI-ARIA APG): a button carrying role="combobox"
          // so the listbox-popup attributes (incl. aria-required/aria-invalid for
          // validation) are permitted on the trigger.
          role="combobox"
          disabled={disabled}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={open ? listboxId : undefined}
          aria-labelledby={labelId}
          aria-required={required || undefined}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          aria-activedescendant={open && activeIndex >= 0 ? optionDomId(activeIndex) : undefined}
          onClick={() => (open ? closeListbox(false) : openListbox(selectedIndex))}
          onKeyDown={handleTriggerKeyDown}
          className={cn(
            triggerBase,
            error ? 'border-error' : 'border-line-strong',
            disabled && 'cursor-not-allowed opacity-60',
          )}
        >
          <span className={cn('truncate', !selectedOption && 'text-ink-placeholder')}>
            {triggerLabel}
          </span>
          <Icon name="chevron-down" className="size-5 text-ink-muted" />
        </button>

        {open ? (
          <div
            id={listboxId}
            role="listbox"
            aria-labelledby={labelId}
            tabIndex={-1}
            className="z-dropdown absolute left-0 right-0 top-full mt-1 max-h-64 overflow-auto rounded-md border border-line-strong bg-surface py-1 shadow-md"
          >
            {options.map((option, index) => {
              const isSelected = option.value === selectedValue;
              const isActive = index === activeIndex;
              return (
                // Virtual-focus listbox option (aria-activedescendant): keyboard is
                // handled on the combobox trigger, and DOM focus deliberately never
                // leaves it, so the option is not itself focusable and has no
                // per-option key handler. axe validates the option semantics.
                <div
                  key={option.value}
                  ref={(node) => {
                    optionRefs.current[index] = node;
                  }}
                  id={optionDomId(index)}
                  role="option"
                  aria-selected={isSelected}
                  data-active={isActive || undefined}
                  // Pointer activation: select on click. `mousedown` is suppressed
                  // so the trigger's outside-click handler doesn't pre-empt it and
                  // so focus stays on the trigger (virtual focus model).
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => commit(index)}
                  className={cn(optionBase, isActive && 'bg-primary-soft text-primary-on-soft')}
                >
                  <span className="truncate">{option.label}</span>
                  {isSelected ? <Icon name="check" className="size-5 text-primary" /> : null}
                </div>
              );
            })}
          </div>
        ) : null}
      </div>

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
  );
}
