// SPDX-License-Identifier: AGPL-3.0-or-later
import type { AnchorHTMLAttributes, ButtonHTMLAttributes, MouseEvent, ReactNode } from 'react';
import { cn } from '../../../lib/cn.js';
import { Icon } from '../Icon/index.js';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'destructive';
export type ButtonSize = 'md' | 'lg';

interface ButtonBaseProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Square icon-only button. Requires an `aria-label` (dev warning otherwise). */
  iconOnly?: boolean;
  /** Shows a spinner, sets `aria-busy`, and blocks activation (no double submit). */
  loading?: boolean;
  /** Visually-hidden text announced while loading (default "Loading…"). */
  loadingLabel?: string;
  /** Disables activation via `aria-disabled` (stays focusable & announced). */
  disabled?: boolean;
  className?: string;
  children?: ReactNode;
}

type ButtonAsButton = ButtonBaseProps & { href?: undefined } & Omit<
    ButtonHTMLAttributes<HTMLButtonElement>,
    keyof ButtonBaseProps
  >;

type ButtonAsAnchor = ButtonBaseProps & { href: string } & Omit<
    AnchorHTMLAttributes<HTMLAnchorElement>,
    keyof ButtonBaseProps | 'href'
  >;

export type ButtonProps = ButtonAsButton | ButtonAsAnchor;

const base =
  'relative inline-flex min-h-touch items-center justify-center gap-2 rounded-md font-medium leading-none whitespace-nowrap select-none transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus';

const sizeClasses: Record<ButtonSize, string> = {
  md: 'text-base',
  lg: 'text-lg',
};

const variantFill: Record<ButtonVariant, string> = {
  primary: 'bg-primary text-primary-fg',
  secondary: 'border border-line-strong bg-surface text-ink',
  ghost: 'bg-transparent text-ink',
  destructive: 'bg-error text-error-fg',
};

const variantInteraction: Record<ButtonVariant, string> = {
  primary: 'hover:bg-primary-hover active:bg-primary-active',
  secondary: 'hover:bg-surface-strong active:bg-surface-strong',
  ghost: 'hover:bg-surface active:bg-surface-strong',
  destructive: 'hover:bg-error-hover active:bg-error-hover',
};

// Neumorphic lighting (WS-B fabric theme): surfaced variants extrude from the
// fabric and depress on press. Ghost has no surface, so it stays flat (a soft
// shadow with no fill reads as a stray glow). Flattens under high-contrast /
// forced-colors via the token layer.
const variantNeu: Record<ButtonVariant, string> = {
  primary: 'neu-raised-sm active:neu-pressed-sm',
  secondary: 'neu-raised-sm active:neu-pressed-sm',
  ghost: '',
  destructive: 'neu-raised-sm active:neu-pressed-sm',
};

export function Button(props: ButtonProps): React.ReactElement {
  const {
    variant = 'secondary',
    size = 'md',
    iconOnly = false,
    loading = false,
    loadingLabel = 'Loading…',
    disabled = false,
    className,
    children,
    href,
    onClick,
    ...rest
  } = props as ButtonBaseProps & {
    href?: string;
    onClick?: (event: MouseEvent<HTMLButtonElement | HTMLAnchorElement>) => void;
  } & Record<string, unknown>;

  const inactive = disabled || loading;
  const ariaLabel = (rest as { 'aria-label'?: string })['aria-label'];

  if (import.meta.env.DEV && iconOnly && !ariaLabel) {
    console.warn(
      'Button: an icon-only button must have an `aria-label` so assistive technology can name it.',
    );
  }

  const classes = cn(
    base,
    sizeClasses[size],
    variantFill[variant],
    !inactive && variantInteraction[variant],
    !inactive && variantNeu[variant],
    iconOnly ? 'min-w-touch px-0' : size === 'lg' ? 'px-5 py-3' : 'px-4 py-2',
    inactive && 'cursor-not-allowed opacity-60',
    className,
  );

  const handleClick = (event: MouseEvent<HTMLButtonElement | HTMLAnchorElement>): void => {
    if (inactive) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    onClick?.(event);
  };

  const content = (
    <>
      {loading ? (
        <>
          <Icon name="refresh" className="size-5 animate-spin" />
          <span className="sr-only">{loadingLabel}</span>
        </>
      ) : null}
      {loading && iconOnly ? null : children}
    </>
  );

  const shared = {
    className: classes,
    'aria-busy': loading || undefined,
    'aria-disabled': inactive || undefined,
    onClick: handleClick,
  };

  if (href !== undefined) {
    return (
      <a {...(rest as AnchorHTMLAttributes<HTMLAnchorElement>)} href={href} {...shared}>
        {content}
      </a>
    );
  }

  return (
    <button type="button" {...(rest as ButtonHTMLAttributes<HTMLButtonElement>)} {...shared}>
      {content}
    </button>
  );
}
