// SPDX-License-Identifier: AGPL-3.0-or-later
import { type InputHTMLAttributes, type ReactNode, useId } from 'react';
import { cn } from '../../../lib/cn.js';
import { Icon } from '../Icon/index.js';

export interface InputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id' | 'className' | 'required'> {
  /** Visible, programmatically-associated label (never replaced by a placeholder). */
  label: string;
  /** Explicit id; auto-generated when omitted. */
  id?: string;
  /** Error message. Sets `aria-invalid` and links the message via `aria-describedby`. */
  error?: string;
  /** Non-error helper text, linked via `aria-describedby`. */
  helperText?: ReactNode;
  required?: boolean;
  /** Visually hide the label while keeping it for assistive tech. */
  hideLabel?: boolean;
  className?: string;
  inputClassName?: string;
}

const inputBase =
  'block min-h-touch w-full rounded-md border bg-canvas px-3 py-2 text-base text-ink transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus';

export function Input({
  label,
  id,
  error,
  helperText,
  required = false,
  hideLabel = false,
  className,
  inputClassName,
  ...rest
}: InputProps): React.ReactElement {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const errorId = `${inputId}-error`;
  const helperId = `${inputId}-helper`;

  const describedBy =
    cn(error ? errorId : undefined, helperText ? helperId : undefined) || undefined;

  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <label
        htmlFor={inputId}
        className={cn('text-sm font-medium text-ink', hideLabel && 'sr-only')}
      >
        {label}
        {required ? (
          <span className="ms-0.5 text-error-on-soft" aria-hidden="true">
            *
          </span>
        ) : null}
      </label>

      <input
        {...rest}
        id={inputId}
        required={required}
        aria-required={required || undefined}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={cn(inputBase, error ? 'border-error' : 'border-line-strong', inputClassName)}
      />

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
