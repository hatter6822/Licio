// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Locale-aware formatting (WS-B.2.14). Thin wrappers over the platform `Intl`
// APIs so dates, numbers, lists and reading estimates render per the active
// locale without a formatting dependency.

export function formatNumber(
  value: number,
  locale: string,
  options?: Intl.NumberFormatOptions,
): string {
  return new Intl.NumberFormat(locale, options).format(value);
}

export function formatDate(
  value: Date | number,
  locale: string,
  options: Intl.DateTimeFormatOptions = { dateStyle: 'medium' },
): string {
  return new Intl.DateTimeFormat(locale, options).format(value);
}

/** Conjunction list ("A, B, and C") in the active locale. */
export function formatList(items: string[], locale: string): string {
  // `Intl.ListFormat` is widely supported; fall back to a comma join if absent.
  const ListFormat = (Intl as { ListFormat?: typeof Intl.ListFormat }).ListFormat;
  if (typeof ListFormat === 'function') {
    return new ListFormat(locale, { style: 'long', type: 'conjunction' }).format(items);
  }
  return items.join(', ');
}

/**
 * Reading estimate as a localized "N min read". The unit string itself comes
 * from the message catalog (passed in) so it is translatable; only the number
 * is `Intl`-formatted here.
 */
export function formatReadingEstimate(
  minutes: number,
  locale: string,
  template: (formattedMinutes: string) => string,
): string {
  const rounded = Math.max(1, Math.round(minutes));
  return template(formatNumber(rounded, locale));
}
