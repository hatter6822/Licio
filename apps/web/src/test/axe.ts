// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Accessibility test helper. Runs axe-core over a rendered DOM subtree.
//
// jsdom has no layout or rendering engine, so axe-core's `color-contrast`
// rule cannot read painted pixels and would report `incomplete` rather than a
// real pass/fail. Color contrast is therefore validated two other ways:
//   1. `design-system/__tests__/contrast.test.ts` recomputes every documented
//      WCAG ratio from the token table (the mathematically authoritative check).
//   2. Playwright e2e runs the full axe ruleset (incl. color-contrast) in real
//      browsers (Chromium, Firefox, WebKit).
// Disabling it here keeps unit-level a11y assertions deterministic and focused
// on structure, roles, names, and ARIA — which jsdom *can* evaluate correctly.
import { type AxeResults, type JestAxeConfigureOptions, axe } from 'jest-axe';

export function checkA11y(
  container: Element | string,
  options: JestAxeConfigureOptions = {},
): Promise<AxeResults> {
  const { rules, ...rest } = options;
  return axe(container, {
    rules: {
      'color-contrast': { enabled: false },
      ...rules,
    },
    ...rest,
  });
}
