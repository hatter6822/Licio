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
