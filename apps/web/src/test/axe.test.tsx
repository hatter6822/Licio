// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The a11y helper's own guard.
//
// `checkA11y` asserts internally so a BARE `await checkA11y(container)` still
// fails on a violation.  That property is the whole reason the assertion moved
// out of the call sites — `axe()` resolves with results and never throws, so
// the bare form used to be a no-op that read exactly like a passing
// accessibility test, and nineteen suites had drifted into it.  If the
// assertion is ever removed from the helper, this file is what notices.
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { checkA11y } from './axe.js';

describe('checkA11y', () => {
  it('REJECTS on a violation even when the caller asserts nothing', async () => {
    // An <img> with no alt text is an unambiguous axe violation. Built through
    // the DOM rather than JSX on purpose: Biome's `a11y/useAltText` rule reads
    // JSX statically and would refuse to let this file compile — which is a
    // second, welcome guard, but not the one under test here.
    const host = document.createElement('div');
    const img = document.createElement('img');
    img.setAttribute('src', '/x.png');
    host.append(img);
    document.body.append(host);
    try {
      await expect(checkA11y(host)).rejects.toThrow();
    } finally {
      host.remove();
    }
  });

  it('resolves with the results for a clean subtree', async () => {
    const { container } = render(<img src="/x.png" alt="A chart of reservoir levels" />);
    const results = await checkA11y(container);
    expect(results.violations).toEqual([]);
  });

  it('still supports the explicit `toHaveNoViolations` form the other suites use', async () => {
    const { container } = render(<button type="button">Save</button>);
    expect(await checkA11y(container)).toHaveNoViolations();
  });

  it('keeps color-contrast disabled — jsdom paints no pixels', async () => {
    // The rule would report `incomplete` rather than a real verdict here; the
    // token table test and the Playwright runs are what check contrast.
    const { container } = render(<p>text</p>);
    const results = await checkA11y(container);
    const ids = (rules: ReadonlyArray<{ id: string }>): string[] => rules.map((rule) => rule.id);
    expect(ids(results.violations)).not.toContain('color-contrast');
    expect(ids(results.incomplete as ReadonlyArray<{ id: string }>)).not.toContain(
      'color-contrast',
    );
  });
});
