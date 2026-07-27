// SPDX-License-Identifier: AGPL-3.0-or-later
import { type KeyboardEvent, useId, useRef, useState } from 'react';
import { cn } from '../../../lib/cn.js';
import { Icon } from '../Icon/index.js';

export interface RadioOption {
  value: string;
  label: string;
}

export interface RadioGroupProps {
  /** Visible group label, associated via `aria-labelledby`. */
  label: string;
  /** Shared form name (informational; the group is rendered with ARIA roles). */
  name?: string;
  /** Controlled selected value. */
  value?: string;
  /** Uncontrolled initial value. */
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  options: RadioOption[];
  /** Error message. Sets `aria-invalid` on the group and links it via `aria-describedby`. */
  error?: string;
  required?: boolean;
  className?: string;
}

const radioBase =
  'inline-flex min-h-touch w-full items-center gap-2 rounded-md px-1 text-base text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus';

// The visual control: an outer ring with an inner dot when selected. The dot is
// the meaningful indicator (not colour alone) and meets 3:1 via currentColor.
const dotBase =
  'flex size-6 shrink-0 items-center justify-center rounded-full border bg-canvas transition-colors';

export function RadioGroup({
  label,
  name,
  value,
  defaultValue,
  onValueChange,
  options,
  error,
  required = false,
  className,
}: RadioGroupProps): React.ReactElement {
  const generatedId = useId();
  const groupId = generatedId;
  const labelId = `${groupId}-label`;
  const errorId = `${groupId}-error`;
  const groupName = name ?? `${groupId}-radio`;

  const isControlled = value !== undefined;
  const [internalValue, setInternalValue] = useState<string | undefined>(defaultValue);
  const selectedValue = isControlled ? value : internalValue;

  // One ref per option button so arrow navigation can move DOM focus.
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);

  // Roving tabindex: exactly one control is tabbable. It is the selected option,
  // or — when nothing is selected yet — the first option, so the group is always
  // reachable with a single Tab and arrows then drive selection (WAI-ARIA APG).
  const selectedIndex = options.findIndex((option) => option.value === selectedValue);
  const tabbableIndex = selectedIndex >= 0 ? selectedIndex : 0;

  const select = (index: number): void => {
    const option = options[index];
    if (!option) {
      return;
    }
    if (!isControlled) {
      setInternalValue(option.value);
    }
    onValueChange?.(option.value);
    buttonRefs.current[index]?.focus();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    const { key } = event;
    const count = options.length;
    if (count === 0) {
      return;
    }

    let next = index;
    switch (key) {
      case 'ArrowDown':
      case 'ArrowRight':
        next = (index + 1) % count;
        break;
      case 'ArrowUp':
      case 'ArrowLeft':
        next = (index - 1 + count) % count;
        break;
      case ' ':
      case 'Enter':
        event.preventDefault();
        select(index);
        return;
      default:
        return;
    }
    // Arrow keys move focus AND selection in a single-select radio group.
    event.preventDefault();
    select(next);
  };

  const describedBy = error ? errorId : undefined;

  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <span id={labelId} className="text-sm font-medium text-ink">
        {label}
        {required ? (
          <span className="ms-0.5 text-error-on-soft" aria-hidden="true">
            *
          </span>
        ) : null}
      </span>

      <div
        role="radiogroup"
        aria-labelledby={labelId}
        aria-required={required || undefined}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className="flex flex-col gap-touch-gap"
      >
        {options.map((option, index) => {
          const checked = option.value === selectedValue;
          return (
            <button
              key={option.value}
              ref={(node) => {
                buttonRefs.current[index] = node;
              }}
              type="button"
              role="radio"
              aria-checked={checked}
              // Single tab stop: only the active option is in the tab order.
              tabIndex={index === tabbableIndex ? 0 : -1}
              data-value={option.value}
              data-name={groupName}
              onClick={() => select(index)}
              onKeyDown={(event) => handleKeyDown(event, index)}
              className={radioBase}
            >
              <span
                aria-hidden="true"
                className={cn(
                  dotBase,
                  error ? 'border-error' : 'border-line-strong',
                  // a11y-bare-hue-ok: `aria-hidden` radio INDICATOR — the hue is
                  // the ring plus the `bg-current` dot below, a graphical UI
                  // component (WCAG 1.4.11, 3:1), never text.  The visible
                  // label is the sibling `<span>` in `text-ink`.
                  checked && 'border-primary text-primary',
                )}
              >
                {checked ? <span className="size-3 rounded-full bg-current" /> : null}
              </span>
              <span>{option.label}</span>
            </button>
          );
        })}
      </div>

      {error ? (
        <p id={errorId} className="flex items-center gap-1 text-sm text-error-on-soft">
          <Icon name="octagon-exclamation" className="size-4" />
          <span>{error}</span>
        </p>
      ) : null}
    </div>
  );
}
