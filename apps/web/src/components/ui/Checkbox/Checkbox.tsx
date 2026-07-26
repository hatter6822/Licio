// SPDX-License-Identifier: AGPL-3.0-or-later
import { type ChangeEvent, type InputHTMLAttributes, useEffect, useId, useRef } from 'react';
import { cn } from '../../../lib/cn.js';
import { Icon } from '../Icon/index.js';

export interface CheckboxProps
  extends Omit<
    InputHTMLAttributes<HTMLInputElement>,
    'id' | 'className' | 'required' | 'type' | 'onChange' | 'checked' | 'defaultChecked'
  > {
  /** Visible, programmatically-associated label. */
  label: string;
  /** Explicit id; auto-generated when omitted. */
  id?: string;
  /** Controlled checked state. */
  checked?: boolean;
  /** Uncontrolled initial checked state. */
  defaultChecked?: boolean;
  /**
   * Tri-state "partially checked" visual. Sets the DOM `indeterminate` property
   * and `aria-checked="mixed"`; takes visual precedence over `checked`.
   */
  indeterminate?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  disabled?: boolean;
  /** Error message. Sets `aria-invalid` and links the message via `aria-describedby`. */
  error?: string;
  required?: boolean;
  className?: string;
}

// The visible box mirrors the native input's state. It is driven entirely by the
// peer input so the rendering can never drift from the accessibility tree.
const boxBase =
  // a11y-bare-hue-ok: `text-primary-fg` colours the CHECK GLYPH, which is only
  // visible under `peer-checked:` / `peer-indeterminate:` — the same states that
  // set `bg-primary` below, the solid background this token is contrast-tested
  // against. The pairing is real; it spans two arguments of one `cn()` call,
  // which a per-literal scan cannot see. On `bg-canvas` the glyph is opacity-0.
  'flex size-6 shrink-0 items-center justify-center rounded-sm border bg-canvas text-primary-fg transition-colors';

export function Checkbox({
  label,
  id,
  checked,
  defaultChecked,
  indeterminate = false,
  onCheckedChange,
  disabled = false,
  error,
  required = false,
  className,
  onClick,
  ...rest
}: CheckboxProps): React.ReactElement {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const errorId = `${inputId}-error`;
  const inputRef = useRef<HTMLInputElement>(null);

  // `indeterminate` is a DOM-only property — it has no HTML attribute — so it
  // must be set imperatively whenever the prop changes.
  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.indeterminate = indeterminate;
    }
  }, [indeterminate]);

  const handleChange = (event: ChangeEvent<HTMLInputElement>): void => {
    onCheckedChange?.(event.target.checked);
  };

  const describedBy = error ? errorId : undefined;

  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <label
        htmlFor={inputId}
        className={cn(
          'group inline-flex min-h-touch items-center gap-2 text-base text-ink',
          disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer',
        )}
      >
        <span className="relative inline-flex">
          <input
            {...rest}
            ref={inputRef}
            id={inputId}
            type="checkbox"
            checked={checked}
            defaultChecked={defaultChecked}
            disabled={disabled}
            required={required}
            aria-required={required || undefined}
            aria-invalid={error ? true : undefined}
            aria-describedby={describedBy}
            aria-checked={indeterminate ? 'mixed' : undefined}
            onChange={handleChange}
            onClick={onClick}
            // Visually hidden but still the real, focusable control. The sibling
            // box renders the appearance and shows the focus ring via peer state.
            className="peer absolute inset-0 size-full cursor-[inherit] appearance-none opacity-0"
          />
          <span
            aria-hidden="true"
            className={cn(
              boxBase,
              error ? 'border-error' : 'border-line-strong',
              // Filled when checked or indeterminate; the indicator icon carries
              // the meaning so colour is never the sole signal. The check icon is
              // revealed by the peer input's :checked state (works controlled or
              // uncontrolled — no JS mirror of the boolean needed).
              'peer-checked:border-primary peer-checked:bg-primary peer-indeterminate:border-primary peer-indeterminate:bg-primary',
              'peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-focus',
              !indeterminate && 'peer-checked:[&>svg]:opacity-100',
            )}
          >
            {indeterminate ? (
              <Icon name="minus" className="size-4" />
            ) : (
              <Icon name="check" className="size-4 opacity-0" />
            )}
          </span>
        </span>

        <span>
          {label}
          {required ? (
            <span className="ms-0.5 text-error-on-soft" aria-hidden="true">
              *
            </span>
          ) : null}
        </span>
      </label>

      {error ? (
        <p id={errorId} className="flex items-center gap-1 text-sm text-error-on-soft">
          <Icon name="octagon-exclamation" className="size-4" />
          <span>{error}</span>
        </p>
      ) : null}
    </div>
  );
}
