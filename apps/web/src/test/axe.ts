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
import { type AxeResults, axe, type JestAxeConfigureOptions } from 'jest-axe';
import { expect } from 'vitest';

/**
 * Run axe over `container` and FAIL the test on any violation.
 *
 * The assertion lives here rather than at each call site because the previous
 * shape — return the results and trust the caller to assert them — is a helper
 * whose name says "check" and whose bare call checks nothing.  `axe()` resolves
 * with an `AxeResults` and never throws, so `await checkA11y(container)` alone
 * is a no-op that reads exactly like a passing accessibility test.  Nineteen
 * call sites across the components, private-rooms, LCAP and migration suites
 * had drifted into that form; every one of them reported coverage it did not
 * have, and no amount of fixing them stops the twentieth.
 *
 * Asserting here makes the misuse unrepresentable and costs the correct callers
 * nothing: `expect(await checkA11y(c)).toHaveNoViolations()` still passes,
 * since a run that reaches the `return` has no violations to report.  The
 * results are still returned for the tests that inspect `incomplete` or
 * `passes`.
 */
export async function checkA11y(
  container: Element | string,
  options: JestAxeConfigureOptions = {},
): Promise<AxeResults> {
  const { rules, ...rest } = options;
  const results = await axe(container, {
    rules: {
      'color-contrast': { enabled: false },
      ...rules,
    },
    ...rest,
  });
  expect(results).toHaveNoViolations();
  return results;
}
