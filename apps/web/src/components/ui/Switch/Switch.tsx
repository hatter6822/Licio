// SPDX-License-Identifier: AGPL-3.0-or-later
import { type ReactNode, useId } from 'react';
import { cn } from '../../../lib/cn.js';

export interface SwitchProps {
  label: ReactNode;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  id?: string;
  disabled?: boolean;
  /** Visually hide the label while keeping it for assistive tech. */
  hideLabel?: boolean;
  /** Optional description, linked via aria-describedby. */
  description?: ReactNode;
  className?: string;
}

/**
 * Toggle switch (role="switch"). Used by the wellbeing controls (WS-B.2.8c) and
 * settings. A real <button role="switch"> so Space/Enter toggle natively;
 * `aria-checked` reflects state and the visible track is never the only signal
 * (the bound label states what is toggled).
 */
export function Switch({
  label,
  checked,
  onCheckedChange,
  id,
  disabled = false,
  hideLabel = false,
  description,
  className,
}: SwitchProps): React.ReactElement {
  const generatedId = useId();
  const switchId = id ?? generatedId;
  const labelId = `${switchId}-label`;
  const descId = `${switchId}-desc`;

  return (
    <div className={cn('flex items-center justify-between gap-3', className)}>
      <span className="flex flex-col">
        <span id={labelId} className={cn('text-base text-ink', hideLabel && 'sr-only')}>
          {label}
        </span>
        {description ? (
          <span id={descId} className="text-sm text-ink-muted">
            {description}
          </span>
        ) : null}
      </span>
      <button
        type="button"
        role="switch"
        id={switchId}
        aria-checked={checked}
        aria-labelledby={labelId}
        aria-describedby={description ? descId : undefined}
        aria-disabled={disabled || undefined}
        onClick={() => {
          if (!disabled) onCheckedChange(!checked);
        }}
        className={cn(
          'relative inline-flex min-h-touch min-w-touch shrink-0 items-center rounded-full p-1 neu-inset transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
          checked ? 'bg-primary' : 'bg-surface-strong',
          disabled && 'cursor-not-allowed opacity-60',
        )}
      >
        {/* The knob extrudes from the recessed track (WS-B fabric theme). */}
        <span
          aria-hidden="true"
          className={cn(
            'pointer-events-none block size-6 rounded-full bg-canvas neu-raised-sm transition-transform',
            checked ? 'translate-x-6' : 'translate-x-0',
          )}
        />
      </button>
    </div>
  );
}
