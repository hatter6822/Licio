// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type ChangeEvent,
  type ReactNode,
  type TextareaHTMLAttributes,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useT } from '../../../i18n/index.js';
import { cn } from '../../../lib/cn.js';
import { Icon } from '../Icon/index.js';

export interface TextAreaProps
  extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'id' | 'className' | 'required'> {
  label: string;
  id?: string;
  error?: string;
  helperText?: ReactNode;
  required?: boolean;
  hideLabel?: boolean;
  /** Character limit. Enables the live-announced count and native input cap. */
  maxLength?: number;
  className?: string;
  textareaClassName?: string;
}

/** Fraction of the limit at which we start warning the user. */
const APPROACHING = 0.9;

const textareaBase =
  // `field-sizing: content` grows the textarea with its content (no JS, no CLS).
  // Browsers without support get the `autosize` JS fallback below; either way
  // `max-h-80` + `overflow-auto` cap the growth and then scroll.
  'block min-h-touch w-full resize-none rounded-md border bg-canvas px-3 py-2 text-base text-ink transition-colors [field-sizing:content] max-h-80 overflow-auto focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus';

export function TextArea({
  label,
  id,
  error,
  helperText,
  required = false,
  hideLabel = false,
  maxLength,
  rows = 3,
  defaultValue,
  value,
  onChange,
  className,
  textareaClassName,
  ...rest
}: TextAreaProps): React.ReactElement {
  const t = useT();
  const generatedId = useId();
  const fieldId = id ?? generatedId;
  const errorId = `${fieldId}-error`;
  const helperId = `${fieldId}-helper`;
  const countId = `${fieldId}-count`;

  const initial = String(value ?? defaultValue ?? '').length;
  const [count, setCount] = useState(initial);
  const current = value !== undefined ? String(value).length : count;

  // Progressive enhancement: where the browser supports CSS `field-sizing`, it
  // handles content-based growth with zero JS. Where it does not (e.g. Firefox at
  // time of writing), fall back to a `scrollHeight`-driven auto-grow so the field
  // still expands with its content. CSSOM height assignment is CSP-safe (no JSX
  // inline styles), and `max-h-80`/`overflow-auto` still bound the height.
  const supportsFieldSizing = useMemo(
    () =>
      typeof CSS !== 'undefined' &&
      typeof CSS.supports === 'function' &&
      CSS.supports('field-sizing', 'content'),
    [],
  );
  const fieldRef = useRef<HTMLTextAreaElement>(null);

  const autosize = useCallback((): void => {
    if (supportsFieldSizing) return;
    const el = fieldRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [supportsFieldSizing]);

  // Size on mount and whenever a controlled `value` changes from outside. `value`
  // is a re-run trigger (the content changed), not read inside the effect.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `value` re-runs the measure on controlled updates
  useEffect(() => {
    autosize();
  }, [autosize, value]);

  const handleChange = (event: ChangeEvent<HTMLTextAreaElement>): void => {
    setCount(event.target.value.length);
    onChange?.(event);
    autosize();
  };

  // Threshold phase drives the live region so announcements fire only when the
  // user crosses 90% and 100% — not on every keystroke (WCAG 4.1.3).
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

  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <label
        htmlFor={fieldId}
        className={cn('text-sm font-medium text-ink', hideLabel && 'sr-only')}
      >
        {label}
        {required ? (
          <span className="ms-0.5 text-error-on-soft" aria-hidden="true">
            *
          </span>
        ) : null}
      </label>

      <textarea
        {...rest}
        ref={fieldRef}
        id={fieldId}
        rows={rows}
        required={required}
        maxLength={maxLength}
        value={value}
        defaultValue={defaultValue}
        onChange={handleChange}
        aria-required={required || undefined}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={cn(
          textareaBase,
          error ? 'border-error' : 'border-line-strong',
          textareaClassName,
        )}
      />

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
            {/* Announced only at the 90% / 100% thresholds. */}
            <span className="sr-only" aria-live="polite">
              {liveMessage}
            </span>
          </p>
        ) : null}
      </div>
    </div>
  );
}
