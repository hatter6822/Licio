// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect } from 'react';
import { useT } from '../../../i18n/index.js';
import { RadioGroup } from '../RadioGroup/index.js';

export type ColorScheme = 'system' | 'light' | 'dark';

/**
 * Apply a colour-scheme preference to the document. `system` removes the
 * override so `prefers-color-scheme` (and the token media queries) take over;
 * `light`/`dark` set `data-theme`, which the generated token layer honours.
 */
export function applyColorScheme(scheme: ColorScheme): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (scheme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', scheme);
}

export interface ThemeToggleProps {
  value: ColorScheme;
  onValueChange: (scheme: ColorScheme) => void;
  /** Reflect the value onto `<html data-theme>` via an effect (default true). */
  apply?: boolean;
  className?: string;
}

/**
 * Manual colour-scheme control (WS-B.1.1a). Complements the
 * `prefers-color-scheme` media query with an explicit System / Light / Dark
 * choice. Built on the accessible RadioGroup (single tab stop, arrow-key
 * selection). Persistence lives in WS-C's UI store; this owns presentation and,
 * optionally, applying the choice to the document.
 */
export function ThemeToggle({
  value,
  onValueChange,
  apply = true,
  className,
}: ThemeToggleProps): React.ReactElement {
  const t = useT();

  useEffect(() => {
    if (apply) applyColorScheme(value);
  }, [apply, value]);

  return (
    <RadioGroup
      label={t('theme.label', 'Colour theme')}
      value={value}
      onValueChange={(next) => onValueChange(next as ColorScheme)}
      options={[
        { value: 'system', label: t('theme.system', 'System') },
        { value: 'light', label: t('theme.light', 'Light') },
        { value: 'dark', label: t('theme.dark', 'Dark') },
      ]}
      {...(className !== undefined ? { className } : {})}
    />
  );
}
