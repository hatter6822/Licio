// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Minimal class-name joiner. We deliberately avoid a `clsx`/`tailwind-merge`
// dependency (dependency-addition checklist item 5: prefer a built-in) — a
// component library where we control the class lists does not need conflict
// resolution, and consumer `className` props are appended last by convention.

export type ClassValue = string | number | false | null | undefined;

/** Join truthy class values into a single space-separated string. */
export function cn(...values: ClassValue[]): string {
  return values.filter((value): value is string | number => Boolean(value)).join(' ');
}

/** Any `max-w-…` utility, including a variant-prefixed one (`md:max-w-lg`). */
const MAX_WIDTH_UTILITY = /(?:^|\s|:)max-w-/;

/**
 * A primitive's DEFAULT max-width, dropped when the call site sets its own.
 *
 * {@link cn} deliberately does not resolve Tailwind conflicts, so a primitive
 * that hard-codes `max-w-xl` in its base list would silently WIN over the
 * `max-w-3xl` a call site passed — the cascade orders by the stylesheet, not by
 * authoring order, so appending the consumer's class last is not enough for two
 * utilities that set the same property. Overlay primitives (Dialog, Sheet) run
 * their default through this instead, so a wider modal actually gets wider.
 */
export function defaultMaxWidth(defaultClass: string, className: string | undefined): string {
  return className !== undefined && MAX_WIDTH_UTILITY.test(className) ? '' : defaultClass;
}
